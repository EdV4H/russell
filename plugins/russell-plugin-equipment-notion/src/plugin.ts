/**
 * 装備プラグイン（§9）: Notion を**読む**。Russell 最初の装備。
 *
 * 装備は「入社時に支給される道具」で、`ctx.equipment.register` に自分を登録し、
 * `ctx.policy` へ各ツールの効果分類を申告する。判定の枠組みと下限はコアが持つ
 * （プラグインは緩和できない, §9.2）。
 *
 * **読むだけでなく、書ける。** ページの作成と追記は `external_write` で、
 * 実行の前に**人の承認**が要る（#113）。承認画面には**どこへ書くか**を名前で出す。
 *
 * 書ける範囲の境界は、読むときと同じで**Notion 側の共有設定**である。統合に共有されて
 * いないページには届かない。共有を外せば即座に書けなくなる（回収と同じ効果, §9.3）。
 *
 * トークンが無いときは**何も register しない**。「未支給の装備はツール定義自体を
 * コンテキストに載せない」（§9.2）——モデルは持っていない能力の存在すら知らない。
 */

import type { AgentContext, RussellPlugin, SourceResult } from "@edv4h/russell-shared";
import { type FetchLike, NotionClient, type NotionPageContent } from "./client.js";
import { findBlock } from "./render.js";
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
   * 場所を指定されなかったときの作成先（既定 env `NOTION_PARENT_PAGE_ID`）。
   *
   * **既定であって、制限ではない。** モデルは `notion.search` で見つけた場所も指定できる。
   * どこへ書くかは承認画面に名前で出るので、**押す人がそこで判断できる**。
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
      // 書ける範囲は**Notion 側の共有設定**がそのまま境界になる（読むときと同じ）。
      // 統合に共有されていないページには、書こうとしても届かない。
      // そのうえで**実行の前に人の承認**が入り、承認画面には**どこへ書くか**を出す。
      const defaultParentId = options.parentPageId ?? process.env.NOTION_PARENT_PAGE_ID;
      ctx.policy.declareEffect("notion.create_page", "external_write");
      ctx.policy.declareEffect("notion.append", "external_write");
      // 編集も external_write。**取り消せない扱いにはしない**——Notion 側にページ履歴が
      // あり、人は戻せる。代わりに**承認画面で何が消えるかを見せる**ことで担保する。
      ctx.policy.declareEffect("notion.edit", "external_write");

      const offEquipment = ctx.equipment.register({
        id: "notion",
        // MCP ではなく HTTP で繋いでいる（ADR 0006）。接続先は Notion の公開 API。
        mcpServer: { kind: "http", baseUrl: "https://api.notion.com/v1" },
        // 統合に共有されたページしか読めない。**スコープの実体は Notion 側の共有設定**で、
        // ここに書くのはその宣言。共有を外せば即座に読めなくなる（回収と同じ効果）。
        scopes: ["notion:read", "notion:write"],
        // 効果分類から**導出**する（external_write → 2。2以上は毎回 HITL, guides/22）。
        // 手で盛らないのと同じく、**手で下げない**——書けるようになった以上、0 ではない。
        // 外部の untrusted テキストを運び込む点は危険度ではなく**来歴**の問題で、
        // 戻り値に trustLabel を付けることで扱う（§12-3）。
        dangerLevel: 2,
        tools: () => [
          { name: "notion.search", effect: "read" },
          { name: "notion.read_page", effect: "read" },
          { name: "notion.create_page", effect: "external_write" as const },
          { name: "notion.append", effect: "external_write" as const },
          { name: "notion.edit", effect: "external_write" as const },
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

      /** 承認画面に出す「どこへ」。**引けなければ id をそのまま見せる**（当てない）。 */
      async function where(pageId: string): Promise<string> {
        return (await client.titleOf(pageId)) ?? pageId;
      }

      /**
       * ページを1枚作る。
       *
       * 親は**モデルが指定できる**（`notion.search` で見つけた id）。省略されたら既定の場所へ。
       * どちらも無ければ作らない——**どこへ書くか分からないまま書きにいかない**。
       */
      const offCreate = ctx.tools.register("notion.create_page", {
        name: "notion.create_page",
        effect: "external_write",
        async describe(input: { title?: string; body?: string; parentPageId?: string }) {
          const parent = (input?.parentPageId ?? defaultParentId ?? "").trim();
          const at = parent ? `〈${await where(parent)}〉の下に` : "（場所の指定なし）";
          return {
            summary: `Notion の ${at}「${(input?.title ?? "").trim()}」を作ります`,
            preview: input?.body ?? "",
          };
        },
        async run(input: { title: string; body: string; parentPageId?: string }): Promise<
          NotionToolResult<NotionPageRef>
        > {
          const title = (input?.title ?? "").trim();
          const body = (input?.body ?? "").trim();
          const parentPageId = (input?.parentPageId ?? defaultParentId ?? "").trim();
          // **中身が無いページを作らない。** 承認を通ったからといって、空を書きに行かない
          if (title === "" || body === "" || parentPageId === "") {
            return untrusted({ status: "failed", freshness: new Date().toISOString() });
          }
          return untrusted(await client.createPage({ parentPageId, title, body }));
        },
      });

      /**
       * すでにあるページに書き足す。**普段いちばん使うのはこちら**——
       * 「このページに追記しておいて」は、新しいページを作る話ではない。
       */
      const offAppend = ctx.tools.register("notion.append", {
        name: "notion.append",
        effect: "external_write",
        async describe(input: { pageId?: string; body?: string }) {
          const id = (input?.pageId ?? "").trim();
          return {
            summary: id
              ? `Notion の〈${await where(id)}〉に書き足します`
              : "Notion に書き足します（ページの指定なし）",
            preview: input?.body ?? "",
          };
        },
        async run(input: { pageId: string; body: string }): Promise<
          NotionToolResult<NotionPageRef>
        > {
          const pageId = (input?.pageId ?? "").trim();
          const body = (input?.body ?? "").trim();
          if (pageId === "" || body === "") {
            return untrusted({ status: "failed", freshness: new Date().toISOString() });
          }
          return untrusted(await client.appendToPage({ pageId, body }));
        },
      });

      /**
       * すでに書いてあるものを直す。**文で場所を指す**（id をモデルに扱わせない）。
       *
       * 追記と違い、**何かが消える**。承認画面には「消える文」と「入る文」を並べて出す——
       * 入る文だけでは、押す人は何が失われるか分からない。
       */
      const offEdit = ctx.tools.register("notion.edit", {
        name: "notion.edit",
        effect: "external_write",
        async describe(input: { pageId?: string; find?: string; replace?: string }) {
          const pageId = (input?.pageId ?? "").trim();
          const blocks = pageId ? await client.listBlocks(pageId) : undefined;
          const hit = blocks ? findBlock(blocks, input?.find ?? "") : undefined;
          const at = pageId ? `〈${await where(pageId)}〉` : "（ページの指定なし）";
          if (!hit || "error" in hit) {
            // **見つからないことも、押す前に見せる。** 押してから失敗するより良い
            const why =
              hit && hit.error === "ambiguous" ? "同じ文が複数あります" : "見つかりません";
            return {
              summary: `Notion の ${at} を直します（${why}）`,
              preview: input?.replace ?? "",
            };
          }
          return {
            summary: `Notion の ${at} の1行を直します`,
            // **消える文と入る文を並べる。** 入る文だけでは何が失われるか分からない
            preview: `− ${hit.found.text}\n＋ ${(input?.replace ?? "").trim()}`,
          };
        },
        async run(input: { pageId: string; find: string; replace: string }): Promise<
          NotionToolResult<NotionPageRef>
        > {
          const pageId = (input?.pageId ?? "").trim();
          const replace = (input?.replace ?? "").trim();
          if (pageId === "" || replace === "") {
            return untrusted({ status: "failed", freshness: new Date().toISOString() });
          }
          const blocks = await client.listBlocks(pageId);
          if (!blocks) return untrusted({ status: "failed", freshness: new Date().toISOString() });
          // **承認した後に、もう一度同じ文で探す。** その間に誰かが直していたら見つからず、
          // 書き換えは起きない（承認したときと違うものを上書きしない）
          const hit = findBlock(blocks, input?.find ?? "");
          if ("error" in hit) {
            return untrusted({ status: "failed", freshness: new Date().toISOString() });
          }
          return untrusted(await client.updateBlockText(hit.found, replace));
        },
      });

      return () => {
        offEdit();
        offAppend();
        offCreate();
        offRead();
        offSearch();
        offEquipment();
      };
    },
  };
}
