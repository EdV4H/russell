/**
 * 装備プラグイン（§9）: Notion を**読む**。Russell 最初の装備。
 *
 * 装備は「入社時に支給される道具」で、`ctx.equipment.register` に自分を登録し、
 * `ctx.policy` へ各ツールの効果分類を申告する。判定の枠組みと下限はコアが持つ
 * （プラグインは緩和できない, §9.2）。
 *
 * **この装備は read しか持たない。** Notion の更新・作成は `external_write` になり、
 * HITL の設計が要る。書けない装備を先に支給するのは、権限の段階的解放（§9.3）の作法でもある。
 *
 * トークンが無いときは**何も register しない**。「未支給の装備はツール定義自体を
 * コンテキストに載せない」（§9.2）——モデルは持っていない能力の存在すら知らない。
 */

import type { AgentContext, RussellPlugin, SourceResult } from "@edv4h/russell-shared";
import { type FetchLike, NotionClient, type NotionPageContent } from "./client.js";
import type { NotionPageRef } from "./render.js";

export interface NotionEquipmentOptions {
  /** 内部インテグレーションのトークン。既定は env `NOTION_TOKEN`。 */
  token?: string;
  /** テスト用。実ネットワークを使わずに動かす。 */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** 検索結果の既定件数。 */
  defaultLimit?: number;
}

/** ツールの戻り値。**中身は必ず untrusted**（他者が Notion に書いたテキスト, §12-3）。 */
export interface NotionToolResult<T> extends SourceResult<T> {
  trustLabel: "untrusted";
}

const untrusted = <T>(result: SourceResult<T>): NotionToolResult<T> => ({
  ...result,
  trustLabel: "untrusted",
});

export function createNotionEquipmentPlugin(options: NotionEquipmentOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-equipment-notion",
    name: "Notion（読み取り）",
    setup(ctx: AgentContext) {
      const token = options.token ?? process.env.NOTION_TOKEN;
      if (!token) {
        // 支給されていない装備として振る舞う。起動は止めない——Notion が無くても個体は働ける。
        console.warn("[equipment-notion] NOTION_TOKEN が無いため、この装備は支給されません。");
        return () => {};
      }

      const client = new NotionClient({
        token,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      const defaultLimit = options.defaultLimit ?? 5;

      // 効果分類の申告（§9.2）。読むだけなので両方 read。
      ctx.policy.declareEffect("notion.search", "read");
      ctx.policy.declareEffect("notion.read_page", "read");

      const offEquipment = ctx.equipment.register({
        id: "notion",
        // MCP ではなく HTTP で繋いでいる（ADR 0006）。接続先は Notion の公開 API。
        mcpServer: { kind: "http", baseUrl: "https://api.notion.com/v1" },
        // 統合に共有されたページしか読めない。**スコープの実体は Notion 側の共有設定**で、
        // ここに書くのはその宣言。共有を外せば即座に読めなくなる（回収と同じ効果）。
        scopes: ["notion:read"],
        // 効果分類から**導出**する（read → 0）。手で盛らない（guides/22）。
        // 外部の untrusted テキストを運び込む点は危険度ではなく**来歴**の問題で、
        // 戻り値に trustLabel を付けることで扱う（§12-3）。
        dangerLevel: 0,
        tools: () => [
          { name: "notion.search", effect: "read" },
          { name: "notion.read_page", effect: "read" },
        ],
      });

      const offSearch = ctx.tools.register("notion.search", {
        name: "notion.search",
        effect: "read",
        async run(input: { query: string; limit?: number }): Promise<
          NotionToolResult<NotionPageRef[]>
        > {
          const query = (input?.query ?? "").trim();
          if (query === "") {
            return untrusted({ status: "complete", data: [], freshness: new Date().toISOString() });
          }
          return untrusted(await client.search(query, input?.limit ?? defaultLimit));
        },
      });

      const offRead = ctx.tools.register("notion.read_page", {
        name: "notion.read_page",
        effect: "read",
        async run(input: { pageId: string }): Promise<NotionToolResult<NotionPageContent>> {
          const pageId = (input?.pageId ?? "").trim();
          if (pageId === "") {
            return untrusted({ status: "failed", freshness: new Date().toISOString() });
          }
          return untrusted(await client.readPage(pageId));
        },
      });

      return () => {
        offRead();
        offSearch();
        offEquipment();
      };
    },
  };
}
