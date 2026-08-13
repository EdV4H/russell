/**
 * 装備プラグイン（§9）: Notion を**読む**。Russell 最初の装備。
 *
 * 装備は「入社時に支給される道具」で、`ctx.equipment.register` に自分を登録し、
 * `ctx.policy` へ各ツールの効果分類を申告する。判定の枠組みと下限はコアが持つ
 * （プラグインは緩和できない, §9.2）。
 *
 * **読むのが主で、書くのは限定的。** ページの作成は `external_write` で、実行の前に
 * 人の承認が要る（#113）。しかも**書く先は1箇所に固定**する（`NOTION_PARENT_PAGE_ID`）——
 * 未設定なら書く道具そのものを支給しない。権限の段階的解放（§9.3）の続きである。
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
  /**
   * 書き込む先の親ページ（既定 env `NOTION_PARENT_PAGE_ID`）。
   *
   * **未設定なら書く道具を支給しない。** 「どこにでも書ける」状態は、承認を挟んでも危ない——
   * 押す人が毎回、書き先の妥当性まで判断させられることになる。
   */
  parentPageId?: string;
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

      // 効果分類の申告（§9.2）。読むのは read、書くのは external_write（人の承認が要る）。
      ctx.policy.declareEffect("notion.search", "read");
      ctx.policy.declareEffect("notion.read_page", "read");
      // **書く先が決まっていなければ、道具そのものを支給しない**（§9.2）。
      // 「どこにでも書ける」状態は、承認を挟んでも危ない——押す人は毎回、
      // 書き先が妥当かどうかまで判断させられることになる。
      const parentPageId = options.parentPageId ?? process.env.NOTION_PARENT_PAGE_ID;
      if (parentPageId) ctx.policy.declareEffect("notion.create_page", "external_write");

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
          ...(parentPageId
            ? [{ name: "notion.create_page", effect: "external_write" as const }]
            : []),
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

      /**
       * ページを1枚作る。**書く先は固定**（`NOTION_PARENT_PAGE_ID` の配下）。
       *
       * 実行の前に人の承認が要る（`external_write`, §12-2）。承認の画面を出すのは
       * コアと通信面の仕事で、ここは**承認が取れた後に呼ばれる**だけである。
       */
      const offCreate = parentPageId
        ? ctx.tools.register("notion.create_page", {
            name: "notion.create_page",
            effect: "external_write",
            async run(input: { title: string; body: string }): Promise<
              NotionToolResult<NotionPageRef>
            > {
              const title = (input?.title ?? "").trim();
              const body = (input?.body ?? "").trim();
              // **中身が無いページを作らない。** 承認を通ったからといって、空を書きに行かない
              if (title === "" || body === "") {
                return untrusted({ status: "failed", freshness: new Date().toISOString() });
              }
              return untrusted(await client.createPage({ parentPageId, title, body }));
            },
          })
        : undefined;

      return () => {
        offCreate?.();
        offRead();
        offSearch();
        offEquipment();
      };
    },
  };
}
