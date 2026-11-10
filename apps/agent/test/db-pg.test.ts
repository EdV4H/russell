/**
 * db-pg の結合テスト。接続を確かめる部分は Postgres が要るので DATABASE_URL がある時だけ実行する。
 * ローカル: `docker compose up -d db` → `DATABASE_URL=postgres://russell:russell@localhost:5432/russell pnpm test`
 *
 * 検証すること:
 * 1. pg を使うプラグインが db プラグインから接続を作る。プールは**用途ごとに別**のまま
 * 2. 接続文字列を明示されたプラグインは db プラグインを使わない
 * 3. DB に届かない・接続先が無いときは起動しない（fail-closed）
 */

import { createAgent } from "@edv4h/russell-core";
import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { createPgDbPlugin } from "@edv4h/russell-plugin-db-pg";
import { createPgKillSwitchPlugin } from "@edv4h/russell-plugin-killswitch-pg";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createPgMemoryPlugin } from "@edv4h/russell-plugin-memory-pg";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import { createPgSettingsPlugin } from "@edv4h/russell-plugin-settings-pg";
import type { RussellPlugin, Temperament } from "@edv4h/russell-shared";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

function boot(agentId: string, plugins: RussellPlugin[]) {
  return createAgent(
    { agentId, configVersion: "v0", temperament: BOB, model: "echo", mode: "dryrun" },
    [...plugins, createEchoModelPlugin()],
  );
}

describe.skipIf(!DB)("db-pg（DATABASE_URL 必須）", () => {
  const admin = new pg.Pool({ connectionString: DB });
  afterAll(async () => {
    await admin.end();
  });

  async function applicationNames(prefix: string): Promise<string[]> {
    const res = await admin.query<{ application_name: string }>(
      `SELECT DISTINCT application_name FROM pg_stat_activity
        WHERE application_name LIKE $1 ORDER BY application_name`,
      [`${prefix}%`],
    );
    return res.rows.map((r) => r.application_name);
  }

  test("pg プラグインは db プラグインから用途ごとに別のプールを作る", async () => {
    const agentId = `dbpg-${process.pid}`;
    const agent = await boot(agentId, [
      createPgDbPlugin(),
      createPgAuditPlugin(),
      createPgKillSwitchPlugin(),
      createPgSettingsPlugin(),
      createPgMemoryPlugin(),
    ]);
    try {
      // 起動時の疎通確認（probe）は閉じてあり、残るのは4つの用途だけ
      expect(await applicationNames(`russell-${agentId}-`)).toEqual([
        `russell-${agentId}-audit`,
        `russell-${agentId}-killswitch`,
        `russell-${agentId}-memory`,
        `russell-${agentId}-settings`,
      ]);
    } finally {
      await agent.destroy();
    }
  });

  test("接続文字列を明示したプラグインは db プラグインを使わない", async () => {
    const agentId = `dbpg-explicit-${process.pid}`;
    const marker = `explicit-${process.pid}`;
    const dsn = `${DB}${DB?.includes("?") ? "&" : "?"}application_name=${marker}`;
    const agent = await boot(agentId, [
      createPgDbPlugin(),
      createPgAuditPlugin({ connectionString: dsn }),
      createInMemoryMemoryPlugin(),
    ]);
    try {
      expect(await applicationNames(marker)).toEqual([marker]);
      expect(await applicationNames(`russell-${agentId}-`)).toEqual([]);
    } finally {
      await agent.destroy();
    }
  });
});

describe("db-pg の起動条件", () => {
  test("DB に届かなければ起動しない", async () => {
    // ポート1は誰も待ち受けていない＝即座に接続拒否になる
    await expect(
      boot("dbpg-unreachable", [
        createPgDbPlugin({ connectionString: "postgres://russell:russell@127.0.0.1:1/russell" }),
        createInMemoryMemoryPlugin(),
      ]),
    ).rejects.toThrow(/Postgres に接続できません/);
  });

  test("接続先が無ければ起動しない（localhost へ黙って繋がない）", async () => {
    const saved = process.env.DATABASE_URL;
    // biome-ignore lint/performance/noDelete: undefined を代入すると文字列 "undefined" になる
    delete process.env.DATABASE_URL;
    try {
      await expect(
        boot("dbpg-missing", [createPgDbPlugin(), createInMemoryMemoryPlugin()]),
      ).rejects.toThrow(/接続先がありません/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
