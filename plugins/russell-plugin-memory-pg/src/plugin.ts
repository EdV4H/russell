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
  MEMORY_SERVICE,
  type MemoryCapability,
  type RecalledContext,
  type RussellPlugin,
} from "@edv4h/russell-shared";
import pg from "pg";
import { MEMORY_MIGRATIONS } from "./migrations.js";

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
      };
      ctx.services.provide<MemoryCapability>(MEMORY_SERVICE, capability);

      ctx.policy.declareEffect("note.write", "internal_write");
      ctx.policy.declareEffect("shelf.add", "internal_write");
      ctx.policy.declareEffect("shelf.forget", "internal_write");
      ctx.policy.declareEffect("deep_recall", "read");

      const offNote = ctx.tools.register("note.write", {
        name: "note.write",
        effect: "internal_write",
        async run(input: { contextId: string; content: string }) {
          await pool.query(
            `INSERT INTO notes (agent_id, context_id, content, expires_at)
             VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
            [agentId, input.contextId, input.content, String(ttlDays)],
          );
          return { status: "succeeded" as const };
        },
      });

      const offShelf = ctx.tools.register("shelf.add", {
        name: "shelf.add",
        effect: "internal_write",
        async run(input: { source: string; card: string; title?: string }) {
          // 見出しはモデルが書く。無ければ本文の頭を切る——索引としては読めないが、
          // 本が載らないよりはよい（判定が壊れても記憶は残す, ADR 0003）。
          const title = input.title?.trim() || input.card.slice(0, 24);
          await pool.query(
            "INSERT INTO books (agent_id, title, source, card) VALUES ($1, $2, $3, $4)",
            [agentId, title, input.source, input.card],
          );
          return { status: "succeeded" as const, title };
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
        offRecall();
        await pool.end();
      };
    },
  };
}
