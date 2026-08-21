/**
 * Drive とドキュメントを読む口。**読み取りだけ。**
 *
 * 見える範囲は **Google 側の共有設定**がそのまま境界になる（Notion の統合と同じ考え方）。
 * Bob に共有されていないものは、探しても出てこない——**権限の説明が「共有したかどうか」で済む**。
 */

import type { SourceResult } from "@edv4h/russell-shared";
import type { FetchLike, GoogleAuth } from "./auth.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
/** Google ドキュメント。会議の文字起こしもこの形で保存される。 */
const DOC_MIME = "application/vnd.google-apps.document";

export interface DriveFile {
  id: string;
  name: string;
  /** 最終更新（ISO8601）。**どれが新しいか**が分からないと選べない。 */
  modifiedAt?: string;
  url?: string;
}

export interface DriveDocument extends DriveFile {
  text: string;
}

export interface GoogleClientOptions {
  auth: GoogleAuth;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** 探すときに使う語を、Drive の検索式へ入れられる形にする。 */
function escapeQuery(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const failed = (): SourceResult<never> => ({
  status: "failed",
  freshness: new Date().toISOString(),
});

export class GoogleClient {
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GoogleClientOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(url: string): Promise<Response | undefined> {
    const token = await this.auth.token();
    if (!token) return undefined; // 認証できない。**空の結果と区別する**ために undefined
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 共有されている Google ドキュメントを探す。
   *
   * **名前で引く。** 全文検索（`fullText`）も可能だが、**会議の文字起こしは本文が長く、
   * 語が当たりやすすぎる**——「先週の定例」を探したいのに、雑談で同じ語が出た別の文書が
   * 上位に来る。まず名前で当て、足りなければ人に聞く方が確実である。
   */
  async search(query: string, limit = 5): Promise<SourceResult<DriveFile[]>> {
    const q = [
      `name contains '${escapeQuery(query)}'`,
      `mimeType = '${DOC_MIME}'`,
      "trashed = false",
    ].join(" and ");
    const params = new URLSearchParams({
      q,
      pageSize: String(Math.min(Math.max(limit, 1), 20)),
      // 新しいものから。**どれが最近の会議か**が分からないと選べない
      orderBy: "modifiedTime desc",
      fields: "files(id,name,modifiedTime,webViewLink)",
      // 共有ドライブに置かれた文書も対象にする（チームで使う置き場はたいていこちら）
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const url = `${DRIVE}/files?${params.toString()}`;

    const res = await this.request(url);
    if (!res || !res.ok) return failed();
    const body = (await res.json()) as {
      files?: { id?: string; name?: string; modifiedTime?: string; webViewLink?: string }[];
    };
    const files = (body.files ?? [])
      .filter((f): f is { id: string; name: string } & typeof f => Boolean(f.id && f.name))
      .map((f) => ({ id: f.id, name: f.name, modifiedAt: f.modifiedTime, url: f.webViewLink }));
    return { status: "complete", freshness: new Date().toISOString(), data: files };
  }

  /**
   * ドキュメント1件を本文つきで読む。
   *
   * 本文は Drive の**書き出し**（`export`）で取る。ドキュメント API を使うと段落や表の構造を
   * 自分で組み立て直すことになり、**読むだけの用途には重い**。
   */
  async read(fileId: string): Promise<SourceResult<DriveDocument>> {
    const metaParams = new URLSearchParams({
      fields: "id,name,modifiedTime,webViewLink",
      supportsAllDrives: "true",
    });
    const metaUrl = `${DRIVE}/files/${encodeURIComponent(fileId)}?${metaParams.toString()}`;
    const meta = await this.request(metaUrl);
    if (!meta || !meta.ok) return failed();
    const file = (await meta.json()) as {
      id?: string;
      name?: string;
      modifiedTime?: string;
      webViewLink?: string;
    };

    const body = await this.request(
      `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
    );
    // 見出しは取れたが本文が読めなかった＝**部分的に取れた**。空の本文を complete と言わない
    if (!body || !body.ok) {
      return {
        status: "partial",
        freshness: new Date().toISOString(),
        data: {
          id: file.id ?? fileId,
          name: file.name ?? "",
          modifiedAt: file.modifiedTime,
          url: file.webViewLink,
          text: "",
        },
      };
    }
    return {
      status: "complete",
      freshness: new Date().toISOString(),
      data: {
        id: file.id ?? fileId,
        name: file.name ?? "",
        modifiedAt: file.modifiedTime,
        url: file.webViewLink,
        text: await body.text(),
      },
    };
  }
}
