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

import type { AgentContext, AuditEvent, RussellPlugin } from "@edv4h/russell-shared";
import pg from "pg";
import { AUDIT_SCHEMA_SQL } from "./schema.js";

export interface PgAuditOptions {
  /** 接続文字列。未指定なら env DATABASE_URL。 */
  connectionString?: string;
  /** dev/test 用にスキーマを起動時作成する（本番は false=マイグレーションツールに委ねる, §11）。 */
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

      if (options.autoMigrate) {
        await pool.query(AUDIT_SCHEMA_SQL);
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
