/**
 * Notion HTTP API の薄い読み取りクライアント。
 *
 * **MCP ではなく HTTP で繋いでいる。** 装備の定義は「MCP接続 + scope + danger + 効果分類」
 * （§9.1）だが、最初の装備は HTTP で実装した。理由は ADR 0006 に書いたが要点は2つ:
 * 公式 MCP サーバーは**書き込みツールも一緒に生えてくる**ので read 専用の装備にならないこと、
 * そして装備1つのためにサブプロセスと別の認証経路を増やしたくないこと。
 *
 * `fetch` を注入できるようにしてあるのは、テストを実際のネットワークから切り離すため。
 *
 * 取得結果は **SourceResult**（§6.3 完全性契約）で返す。「見つからなかった」と
 * 「取りに行けなかった」を同じ空配列にしない——後者を前者と混同すると、
 * 個体が「Notion には何もありませんでした」と嘘をつく。
 */

import type { SourceResult } from "@edv4h/russell-shared";
import { type NotionPageRef, blocksToText, pageTitle, toPageRef } from "./render.js";

/** Notion のバージョンヘッダ。上げるときは動作確認とセットで。 */
const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NotionClientOptions {
  token: string;
  fetchImpl?: FetchLike;
  /** 1リクエストの上限。既定10秒。外部 I/O が会話のレイテンシを持っていかないように。 */
  timeoutMs?: number;
}

export interface NotionPageContent extends NotionPageRef {
  /** ブロックから起こした本文。**untrusted**（他者が書いた外部テキスト, §12-3）。 */
  text: string;
}

/** HTTP のステータスから完全性契約の status へ落とす。 */
function statusFor(httpStatus: number): SourceResult["status"] {
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  return "failed";
}

export class NotionClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: NotionClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${API}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ワークスペースを検索する。**統合に共有されたページしか返らない**のは Notion 側の仕様で、
   * これがそのまま装備のスコープになっている（共有しない限り読めない）。
   */
  async search(query: string, limit = 5): Promise<SourceResult<NotionPageRef[]>> {
    try {
      const res = await this.request("/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          page_size: Math.min(Math.max(limit, 1), 20),
          sort: { direction: "descending", timestamp: "last_edited_time" },
        }),
      });
      if (!res.ok) return { status: statusFor(res.status), freshness: new Date().toISOString() };

      const body = (await res.json()) as { results?: unknown[]; has_more?: boolean };
      const results = (body.results ?? [])
        .map(toPageRef)
        .filter((r): r is NotionPageRef => r !== undefined);
      return {
        // 続きがあるなら complete とは名乗らない（§6.3。「全部見た」と言えるときだけ complete）
        status: body.has_more ? "partial" : "complete",
        freshness: new Date().toISOString(),
        data: results,
      };
    } catch {
      return { status: "failed", freshness: new Date().toISOString() };
    }
  }

  /** ページ1件を読む（プロパティ + 本文ブロック）。 */
  async readPage(pageId: string): Promise<SourceResult<NotionPageContent>> {
    try {
      const pageRes = await this.request(`/pages/${encodeURIComponent(pageId)}`, { method: "GET" });
      if (!pageRes.ok)
        return { status: statusFor(pageRes.status), freshness: new Date().toISOString() };
      const page = (await pageRes.json()) as Record<string, unknown>;

      const blocksRes = await this.request(
        `/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
        { method: "GET" },
      );
      // ページは読めたが本文が読めなかった＝**部分的に取れた**。空の本文を complete と言わない
      if (!blocksRes.ok) {
        return {
          status: "partial",
          freshness: new Date().toISOString(),
          data: {
            id: pageId,
            title: pageTitle(page),
            url: typeof page.url === "string" ? page.url : "",
            lastEditedAt:
              typeof page.last_edited_time === "string" ? page.last_edited_time : undefined,
            text: "",
          },
        };
      }
      const blocks = (await blocksRes.json()) as { results?: unknown[]; has_more?: boolean };

      return {
        status: blocks.has_more ? "partial" : "complete",
        freshness: new Date().toISOString(),
        data: {
          id: pageId,
          title: pageTitle(page),
          url: typeof page.url === "string" ? page.url : "",
          lastEditedAt:
            typeof page.last_edited_time === "string" ? page.last_edited_time : undefined,
          text: blocksToText(blocks.results ?? []),
        },
      };
    } catch {
      return { status: "failed", freshness: new Date().toISOString() };
    }
  }
}
