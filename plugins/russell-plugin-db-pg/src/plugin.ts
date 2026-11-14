/**
 * DB プラグイン（Postgres）: 接続先と接続の作り方を1か所に持ち、`DbCapability` として配る。
 *
 * これまでは pg を使うプラグインがそれぞれ env DATABASE_URL を読んでいた。接続先は1つなのに、
 * SSL やプールの大きさを足すたびに全プラグインを揃え直すことになる。本番の置き場所
 * （マネージドの Postgres）へ移すときに効いてくる。
 *
 * **プールは配らない。作り方を配る。** 監査・凍結判定・記憶は今までどおり別々のプールを持つ
 * （1本を共有すると、記憶の重いクエリが監査の書き込みを待たせる, §12-7）。
 *
 * このプラグインが無い構成でも各プラグインは今までどおり動く（env DATABASE_URL を読む）。
 * 配列では pg を使うプラグインより前に置く（provider を consumer より前に）。
 */

import type { AgentContext, DbCapability, RussellPlugin } from "@edv4h/russell-shared";
import { DB_SERVICE } from "@edv4h/russell-shared";
import pg from "pg";

export interface PgDbOptions {
  /** 接続文字列。未指定なら env DATABASE_URL。 */
  connectionString?: string;
  /** 接続文字列以外のプール設定（SSL・max・タイムアウトなど）。作るプールすべてに入る。 */
  pool?: Omit<pg.PoolConfig, "connectionString">;
}

export function createPgDbPlugin(options: PgDbOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-db-pg",
    name: "Postgres Connection",
    async setup(ctx: AgentContext) {
      const connectionString = options.connectionString ?? process.env.DATABASE_URL;
      // 未指定のまま pg に渡すと localhost へ繋ぎに行き、別の DB に書く事故になりうる。
      if (!connectionString) {
        throw new Error("[db-pg] 接続先がありません（connectionString か env DATABASE_URL）。");
      }
      const agentId = ctx.runtime.agentId;

      const createPool = (purpose: string): pg.Pool =>
        new pg.Pool({
          ...options.pool,
          connectionString,
          application_name: options.pool?.application_name ?? `russell-${agentId}-${purpose}`,
        });

      // 繋がらないなら起動しない（fail-closed）。各プラグインのスキーマ確認より先に、
      // 「DB に届かない」のか「スキーマが無い」のかを分けて出す。
      const probe = createPool("probe");
      probe.on("error", () => {}); // 判定は下の catch で行う
      try {
        await probe.query("SELECT 1");
      } catch (err) {
        throw new Error(`[db-pg] Postgres に接続できません: ${(err as Error).message}`);
      } finally {
        await probe.end();
      }

      ctx.services.provide<DbCapability<pg.Pool>>(DB_SERVICE, { dialect: "postgres", createPool });
    },
  };
}
