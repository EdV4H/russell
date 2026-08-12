/**
 * 記憶プラグイン（本番）: Postgres + pgvector。
 * memory-inmem と同じ契約（MemoryCapability ＋ note.write/shelf.add/deep_recall）を
 * Postgres で実装する。個体ごとに agent_id で分離（§8.2）。
 *
 * P0 の範囲: notes（メモ帳・TTL7日）と books（本棚）の最小。埋め込み・忘却曲線・書庫スイープは
 * 夜間バッチ（P1）で足す。ここでは recall は recency、deep_recall は本文一致で足りる（発注書 §2）。
 */

import { assertAutoMigrateAllowed, assertSchemaReady, runMigrations } from "@edv4h/russell-migrate";
import {
  type AgentContext,
  type GlossaryEntry,
  MEMORY_SERVICE,
  type MemoryCapability,
  type OpenTodo,
  type RecalledContext,
  type RecalledPerson,
  type RecalledTerm,
  type RussellPlugin,
} from "@edv4h/russell-shared";
import pg from "pg";
import { MEMORY_MIGRATIONS } from "./migrations.js";
import { type StoredTerm, TERM_CACHE_MS, matchTerms } from "./terms.js";

export interface PgMemoryOptions {
  /** 接続文字列。未指定なら env DATABASE_URL。 */
  connectionString?: string;
  /**
   * dev/test 用に起動時マイグレーションを走らせる。本番（NODE_ENV=production）では拒否される。
   * 既定 false ＝ **DDL は流さず「適用済みか」を確認するだけ**（§11）。
   */
  autoMigrate?: boolean;
  /** メモの既定 TTL（日）。§3.1 既定7日。 */
  noteTtlDays?: number;
}

export function createPgMemoryPlugin(options: PgMemoryOptions = {}): RussellPlugin {
  const ttlDays = options.noteTtlDays ?? 7;
  return {
    id: "russell-plugin-memory-pg",
    name: "Postgres Memory (pgvector)",
    async setup(ctx: AgentContext) {
      const agentId = ctx.runtime.agentId;
      const pool = new pg.Pool({
        connectionString: options.connectionString ?? process.env.DATABASE_URL,
      });
      // idle 接続が切れただけでプロセスを落とさない（pg.Pool は listener が無いと
      // unhandled 'error' event で死ぬ）。記憶が読めない状況は次のクエリの失敗で扱う。
      pool.on("error", (err) => {
        console.error("[memory-pg] Postgres 接続エラー（プールが再接続します）:", err.message);
      });

      // スキーマが未適用なら起動しない（fail-closed）。起動時に DDL は流さない（§11）。
      try {
        if (options.autoMigrate) {
          assertAutoMigrateAllowed(MEMORY_MIGRATIONS.namespace);
          await runMigrations(pool, [MEMORY_MIGRATIONS]);
        } else {
          await assertSchemaReady(pool, [MEMORY_MIGRATIONS]);
        }
      } catch (err) {
        await pool.end();
        throw err;
      }

      /** 索引カードのキャッシュ（type ごと）。書き込みで無効化するので、TTL は保険。 */
      const cards = new Map<string, { rows: StoredTerm[]; until: number }>();

      async function loadEntities(type: string): Promise<StoredTerm[]> {
        const hit = cards.get(type);
        if (hit && Date.now() < hit.until) return hit.rows;
        const res = await pool.query<StoredTerm>(
          "SELECT name, summary, aliases FROM entities WHERE agent_id = $1 AND type = $2",
          [agentId, type],
        );
        cards.set(type, { rows: res.rows, until: Date.now() + TERM_CACHE_MS });
        return res.rows;
      }

      /** 索引カードを1件書く（同じ名前は更新）。用語も人も同じ形。 */
      async function upsertEntity(input: {
        type: string;
        name: string;
        summary: string;
        aliases?: string[];
        sensitive?: string[];
        externalIds?: string[];
      }): Promise<boolean> {
        const name = input.name.trim();
        const summary = input.summary.trim();
        if (name === "" || summary === "") return false;
        // 別名は**和集合で足す**。減らすのは人の操作に限る（勝手に呼び名を忘れない）
        await pool.query(
          `INSERT INTO entities (agent_id, name, type, aliases, summary, sensitive_categories, external_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (agent_id, type, lower(name)) DO UPDATE
             SET summary = EXCLUDED.summary,
                 aliases = ARRAY(SELECT DISTINCT unnest(entities.aliases || EXCLUDED.aliases)),
                 sensitive_categories = EXCLUDED.sensitive_categories,
                 -- 紐付けも和集合。**一度ついた対応を外さない**（外すのは人の操作）
                 external_ids = ARRAY(SELECT DISTINCT unnest(entities.external_ids || EXCLUDED.external_ids)),
                 updated_at = now()`,
          [
            agentId,
            name,
            input.type,
            input.aliases ?? [],
            summary,
            input.sensitive ?? [],
            input.externalIds ?? [],
          ],
        );
        cards.delete(input.type); // 次の想起で読み直す
        return true;
      }

      const capability: MemoryCapability = {
        async recall(contextId: string): Promise<RecalledContext> {
          const notesRes = await pool.query<{ content: string }>(
            `SELECT content FROM notes
             WHERE agent_id = $1 AND context_id = $2
               AND (expires_at IS NULL OR expires_at > now())
             ORDER BY created_at DESC LIMIT 20`,
            [agentId, contextId],
          );
          const booksRes = await pool.query<{ title: string; card: string }>(
            `SELECT title, card FROM books
             WHERE agent_id = $1 AND status = 'active'
             ORDER BY created_at DESC LIMIT 5`,
            [agentId],
          );
          return {
            notes: notesRes.rows.map((r) => r.content).reverse(),
            books: booksRes.rows,
          };
        },
        /**
         * 受信テキストに出てくる既知の用語を引く（単語帳）。
         *
         * **モデルを使わない。** 別名は文字列なので照合で足りる。用語は数十〜数百件なので
         * 全件をキャッシュして手元で突き合わせる方が、毎回 SQL を投げるより速い。
         */
        /** 受信テキストに出てくる人を引く（個人カルテ）。用語と同じく照合だけ。 */
        async people(text: string): Promise<RecalledPerson[]> {
          const rows = await loadEntities("person");
          return matchTerms(text, rows).map((m) => ({ name: m.name, note: m.definition }));
        },
        /** 引き受けたまま終わっていない作業。**何日止まっているか**も返す。 */
        async openTodos(contextId?: string): Promise<OpenTodo[]> {
          const res = await pool.query<{
            id: string;
            content: string;
            state: string;
            waiting_for: string | null;
            stale_days: string;
          }>(
            `SELECT id, content, state, waiting_for,
                    floor(extract(epoch from now() - updated_at) / 86400) AS stale_days
               FROM todos
              WHERE agent_id = $1 AND state IN ('open', 'waiting')
                AND ($2::text IS NULL OR context_id = $2)
              ORDER BY updated_at ASC LIMIT 50`,
            [agentId, contextId ?? null],
          );
          return res.rows.map((r) => ({
            id: Number(r.id),
            content: r.content,
            state: r.state === "waiting" ? "waiting" : "open",
            waitingFor: r.waiting_for ?? undefined,
            staleDays: Number(r.stale_days),
          }));
        },
        /** 登録済みの見出し語（本文は返さない）。更新順で、モデルに見せる分だけ。 */
        async glossary(): Promise<GlossaryEntry[]> {
          const res = await pool.query<GlossaryEntry>(
            `SELECT name, aliases FROM entities
              WHERE agent_id = $1 AND type = 'term' ORDER BY updated_at DESC LIMIT 200`,
            [agentId],
          );
          return res.rows;
        },
        async terms(text: string): Promise<RecalledTerm[]> {
          return matchTerms(text, await loadEntities("term"));
        },
      };
      ctx.services.provide<MemoryCapability>(MEMORY_SERVICE, capability);

      ctx.policy.declareEffect("note.write", "internal_write");
      ctx.policy.declareEffect("shelf.add", "internal_write");
      ctx.policy.declareEffect("shelf.forget", "internal_write");
      ctx.policy.declareEffect("deep_recall", "read");
      ctx.policy.declareEffect("term.define", "internal_write");
      ctx.policy.declareEffect("person.remember", "internal_write");
      ctx.policy.declareEffect("todo.add", "internal_write");
      ctx.policy.declareEffect("todo.close", "internal_write");
      // 物理削除。効果分類として最も重い（danger は効果から導出, guides/22）
      ctx.policy.declareEffect("person.forget", "irreversible_write");

      const offNote = ctx.tools.register("note.write", {
        name: "note.write",
        effect: "internal_write",
        async run(input: { contextId: string; content: string; sensitive?: string[] }) {
          // 機微情報の印（A-1 / ADR 0007）。記憶からは落とさず、公開経路がこれを見て出さない。
          await pool.query(
            `INSERT INTO notes (agent_id, context_id, content, expires_at, sensitive_categories)
             VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5)`,
            [agentId, input.contextId, input.content, String(ttlDays), input.sensitive ?? []],
          );
          return { status: "succeeded" as const };
        },
      });

      const offShelf = ctx.tools.register("shelf.add", {
        name: "shelf.add",
        effect: "internal_write",
        async run(input: { source: string; card: string; title?: string; sensitive?: string[] }) {
          // 見出しはモデルが書く。無ければ本文の頭を切る——索引としては読めないが、
          // 本が載らないよりはよい（判定が壊れても記憶は残す, ADR 0003）。
          const title = input.title?.trim() || input.card.slice(0, 24);
          // 会話中に直接書かれた本（明示的に頼まれた場合だけ）。言われずに効く知識は
          // 夜間バッチがメモから昇格させる（origin='promoted', ADR 0005）。
          await pool.query(
            `INSERT INTO books (agent_id, title, source, card, origin, sensitive_categories)
             VALUES ($1, $2, $3, $4, 'conversation', $5)`,
            [agentId, title, input.source, input.card, input.sensitive ?? []],
          );
          return { status: "succeeded" as const, title };
        },
      });

      // 単語帳への書き込み（索引カード, ADR 0008）。**同じ語は1件で更新**する——
      // 本棚のように積み上げて夜に畳むのではない。定義は1つあってほしい。
      const offTerm = ctx.tools.register("term.define", {
        name: "term.define",
        effect: "internal_write",
        async run(input: {
          name: string;
          definition: string;
          aliases?: string[];
          sensitive?: string[];
        }) {
          const saved = await upsertEntity({
            type: "term",
            name: input.name ?? "",
            summary: input.definition ?? "",
            aliases: input.aliases,
            sensitive: input.sensitive,
          });
          return { status: "succeeded" as const, saved };
        },
      });

      // 個人カルテ（ADR 0008）。**何を書くかの制約は判定プロンプト側**にあり、
      // ここは器。器の側で守るのは「同じ人は1件で更新」と「別名を失わない」だけ。
      const offPerson = ctx.tools.register("person.remember", {
        name: "person.remember",
        effect: "internal_write",
        async run(input: {
          name: string;
          note: string;
          aliases?: string[];
          sensitive?: string[];
          externalIds?: string[];
        }) {
          const saved = await upsertEntity({
            type: "person",
            name: input.name ?? "",
            summary: input.note ?? "",
            aliases: input.aliases,
            sensitive: input.sensitive,
            externalIds: input.externalIds,
          });
          return { status: "succeeded" as const, saved };
        },
      });

      // 人の記憶を消す（退職者対応 / 削除依頼）。**記憶で唯一の物理削除**——
      // privacy-and-memory-policy が人物データを明示的に例外にしているため（§2 offboard_days）。
      // 個体の判断では呼ばせない: 運用者が CLI から invokeTool で叩く経路だけを想定している。
      const offForgetPerson = ctx.tools.register("person.forget", {
        name: "person.forget",
        effect: "irreversible_write",
        async run(input: { name: string }) {
          const name = (input.name ?? "").trim();
          if (name === "") return { status: "succeeded" as const, deleted: 0 };
          const res = await pool.query(
            "DELETE FROM entities WHERE agent_id = $1 AND type = 'person' AND lower(name) = lower($2)",
            [agentId, name],
          );
          cards.delete("person");
          return { status: "succeeded" as const, deleted: res.rowCount ?? 0 };
        },
      });

      // 引き受けた作業を記録する（ADR 0009）。**同じ作業を二重に持たない**ように、
      // 判定には既存の未完了を見せてある（単語帳の重複対策と同じ手）。
      const offTodoAdd = ctx.tools.register("todo.add", {
        name: "todo.add",
        effect: "internal_write",
        async run(input: {
          content: string;
          contextId?: string;
          waitingFor?: string;
          sensitive?: string[];
        }) {
          const content = (input.content ?? "").trim();
          if (content === "") return { status: "succeeded" as const, saved: false };
          const res = await pool.query<{ id: string }>(
            `INSERT INTO todos (agent_id, content, state, context_id, waiting_for, sensitive_categories)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              agentId,
              content,
              input.waitingFor ? "waiting" : "open",
              input.contextId ?? null,
              input.waitingFor ?? null,
              input.sensitive ?? [],
            ],
          );
          return { status: "succeeded" as const, saved: true, id: Number(res.rows[0]?.id) };
        },
      });

      // 終わった／やらないと決めた。**消さずに状態を変える**（判断も記録なので, §3.4 と同じ扱い）。
      const offTodoClose = ctx.tools.register("todo.close", {
        name: "todo.close",
        effect: "internal_write",
        async run(input: { id: number; state?: "done" | "dropped" }) {
          const res = await pool.query(
            `UPDATE todos SET state = $3, closed_at = now(), updated_at = now()
              WHERE agent_id = $1 AND id = $2 AND state IN ('open', 'waiting')`,
            [agentId, input.id, input.state === "dropped" ? "dropped" : "done"],
          );
          return { status: "succeeded" as const, closed: res.rowCount ?? 0 };
        },
      });

      // 「忘れて」= L1（弱める）。strength を下限まで下げて書庫へ落とす。
      // 物理削除（L2）は HITL 承認が前提（privacy-and-memory-policy §3）なので、
      // それが入るまでは可逆なこの段階だけを提供する。**消したと言わない**ことが重要。
      const offForget = ctx.tools.register("shelf.forget", {
        name: "shelf.forget",
        effect: "internal_write",
        async run(input: { query: string }) {
          const q = input.query ?? "";
          if (q.trim() === "") return { status: "succeeded" as const, archived: 0, titles: [] };
          const res = await pool.query<{ title: string }>(
            `UPDATE books SET strength = 0, status = 'archived'
              WHERE agent_id = $1 AND status = 'active' AND card ILIKE '%' || $2 || '%'
              RETURNING title`,
            [agentId, q],
          );
          return {
            status: "succeeded" as const,
            archived: res.rowCount ?? 0,
            titles: res.rows.map((r) => r.title),
          };
        },
      });

      const offRecall = ctx.tools.register("deep_recall", {
        name: "deep_recall",
        effect: "read",
        async run(input: { query: string }) {
          const res = await pool.query<{ title: string; card: string }>(
            `SELECT title, card FROM books
             WHERE agent_id = $1 AND card ILIKE '%' || $2 || '%'
             ORDER BY created_at DESC LIMIT 20`,
            [agentId, input.query ?? ""],
          );
          return res.rows;
        },
      });

      return async () => {
        offNote();
        offShelf();
        offForget();
        offTerm();
        offPerson();
        offTodoAdd();
        offTodoClose();
        offForgetPerson();
        offRecall();
        await pool.end();
      };
    },
  };
}
