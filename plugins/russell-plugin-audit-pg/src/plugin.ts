/**
 * 監査ログプラグイン（本番）: Postgres の `event_log` へ追記する AuditSink。
 *
 * コアは AuditSink 契約しか知らない（plugin-first）。永続化先を差し替えたければ
 * 同じ契約で別プラグインを書けばよい（S3/BigQuery 等）。
 *
 * 記憶（memory-pg）とは**別プラグイン・別プール**にしている。監査は記憶より先に必要で、
 * 記憶実装を差し替えても（inmem にしても）監査は残せなければならないため。
 *
 * 失敗は握り潰さず throw する。コアはそれを検知して fail-closed へ倒す（§12-7）。
 */

import { assertAutoMigrateAllowed, assertSchemaReady, runMigrations } from "@edv4h/russell-migrate";
import type { AgentContext, AuditEvent, RussellPlugin } from "@edv4h/russell-shared";
import pg from "pg";
import { AUDIT_MIGRATIONS } from "./migrations.js";

export interface PgAuditOptions {
  /** 接続文字列。未指定なら env DATABASE_URL。 */
  connectionString?: string;
  /**
   * dev/test 用に起動時マイグレーションを走らせる。本番（NODE_ENV=production）では拒否される。
   * 既定 false ＝ **DDL は流さず「適用済みか」を確認するだけ**（§11）。
   */
  autoMigrate?: boolean;
}

export function createPgAuditPlugin(options: PgAuditOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-audit-pg",
    name: "Postgres Audit Log (event_log)",
    async setup(ctx: AgentContext) {
      const pool = new pg.Pool({
        connectionString: options.connectionString ?? process.env.DATABASE_URL,
      });
      // idle 接続が切れただけでプロセスを落とさない（pg.Pool は listener が無いと
      // unhandled 'error' event で死ぬ）。DB の再起動・フェイルオーバのたびに個体が
      // 落ちるのは fail-closed ではなく可用性の欠陥。判定は次のクエリの失敗で行う。
      pool.on("error", (err) => {
        console.error("[audit-pg] Postgres 接続エラー（プールが再接続します）:", err.message);
      });

      // スキーマが未適用なら起動しない（fail-closed）。監査が落ちる先を先に確かめる。
      try {
        if (options.autoMigrate) {
          assertAutoMigrateAllowed(AUDIT_MIGRATIONS.namespace);
          await runMigrations(pool, [AUDIT_MIGRATIONS]);
        } else {
          await assertSchemaReady(pool, [AUDIT_MIGRATIONS]);
        }
      } catch (err) {
        await pool.end();
        throw err;
      }

      const unregister = ctx.audit.registerSink({
        id: "audit-pg",
        async write(event: AuditEvent) {
          await pool.query(
            `INSERT INTO event_log (ts, agent_id, config_version, actor, action, payload, trust_label)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [
              event.ts,
              event.agentId,
              event.configVersion,
              event.actor,
              event.action,
              JSON.stringify(event.payload),
              event.trustLabel,
            ],
          );
        },
      });

      return async () => {
        unregister();
        await pool.end();
      };
    },
  };
}
