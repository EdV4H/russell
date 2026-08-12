/**
 * 運用設定プラグイン（Postgres の `agent_settings`）。
 *
 * 「日報をどのチャンネルへ出すか」のような**運用の判断**を持つ。env に置くと
 * 変えるたびに再起動が要り、**誰がいつ変えたか残らない**。設計は運用設定を
 * config_version 側に置き、変更履歴を event_log へ残すと定めている（§6.1）。
 */

import { assertAutoMigrateAllowed, assertSchemaReady, runMigrations } from "@edv4h/russell-migrate";
import type { AgentContext, RussellPlugin, SettingsCapability } from "@edv4h/russell-shared";
import { SETTINGS_SERVICE } from "@edv4h/russell-shared";
import pg from "pg";
import { SETTINGS_MIGRATIONS } from "./migrations.js";
import { readSetting, writeSetting } from "./store.js";

export interface PgSettingsOptions {
  connectionString?: string;
  autoMigrate?: boolean;
}

export function createPgSettingsPlugin(options: PgSettingsOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-settings-pg",
    name: "Agent Settings (Postgres)",
    async setup(ctx: AgentContext) {
      const pool = new pg.Pool({
        connectionString: options.connectionString ?? process.env.DATABASE_URL,
      });
      pool.on("error", (err) => {
        console.error("[settings-pg] Postgres 接続エラー:", err.message);
      });
      try {
        if (options.autoMigrate) {
          assertAutoMigrateAllowed(SETTINGS_MIGRATIONS.namespace);
          await runMigrations(pool, [SETTINGS_MIGRATIONS]);
        } else {
          await assertSchemaReady(pool, [SETTINGS_MIGRATIONS]);
        }
      } catch (err) {
        await pool.end();
        throw err;
      }

      const selfId = ctx.runtime.agentId;
      const capability: SettingsCapability = {
        get: (key, agentId) => readSetting(pool, agentId ?? selfId, key),
        async set(key, value, updatedBy, agentId) {
          const target = agentId ?? selfId;
          const before = await readSetting(pool, target, key);
          await writeSetting(pool, target, key, value, updatedBy);
          // 設定の変更は監査に残す（§6.1）。**値も残す**——チャンネル ID は本文ではないし、
          // 「どこへ出す設定になっていたか」を後から追えないと事故の調査ができない。
          await ctx.audit.record({
            actor: updatedBy,
            action: "settings.changed",
            payload: { key, target, from: before ?? null, to: value },
            trustLabel: "trusted",
          });
          return { before };
        },
      };
      ctx.services.provide<SettingsCapability>(SETTINGS_SERVICE, capability);

      return async () => {
        await pool.end();
      };
    },
  };
}
