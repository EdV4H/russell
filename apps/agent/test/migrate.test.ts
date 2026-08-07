/**
 * 横断ゲート「マイグレーション」の結合テスト（§11）。要 DATABASE_URL。
 * ローカル: `docker compose up -d db` → `DATABASE_URL=postgres://russell:russell@localhost:5432/russell pnpm test`
 *
 * 空の DB を毎回作って検証する（共有 DB では「スキーマが無い状態」を作れないため）:
 * 1. **起動時に CREATE TABLE をしない** — 未適用の DB ではエージェントが起動しない（fail-closed）
 * 2. 適用は冪等・多重起動でも二重適用しない
 * 3. 適用済みマイグレーションの改変を検出して止まる
 * 4. **expand→backfill→contract** が3段で回る（contract は明示指定が要る）
 */

import { createAgent } from "@edv4h/russell-core";
import {
  type MigrationSet,
  assertSchemaReady,
  migrationStatus,
  runMigrations,
} from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS, createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import type { Temperament } from "@edv4h/russell-shared";
import pg from "pg";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

let dbSeq = 0;

/**
 * このテスト専用のプール。**接続断を無視するハンドラを必ず付ける。**
 *
 * 後片付けの `DROP DATABASE ... WITH (FORCE)` は接続を強制的に切るので、その瞬間に
 * プールが 'error' を出す。リスナが無いと unhandled 'error' event になり、
 * テスト自体は全部通っているのに vitest が異常終了する（タイミング次第で再現するので
 * CI が時々落ちる形になる）。ここでの接続断は**意図した後片付け**なので握り潰してよい。
 */
function testPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", () => {});
  return pool;
}

/** 空の DB を作って渡し、終わったら落とす。 */
async function withEmptyDatabase(fn: (url: string) => Promise<void>): Promise<void> {
  const admin = testPool(DB as string);
  const name = `russell_mig_${process.pid}_${dbSeq++}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DB as string);
  url.pathname = `/${name}`;
  try {
    await fn(url.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/** 列名の付け替えを3段でやる例。ゲートの本体はこの「3段で回ること」。 */
const RENAME_DEMO: MigrationSet = {
  namespace: "demo",
  migrations: [
    {
      id: "0001_create",
      phase: "expand",
      sql: "CREATE TABLE demo (id BIGSERIAL PRIMARY KEY, name_old TEXT)",
    },
    { id: "0002_add_name", phase: "expand", sql: "ALTER TABLE demo ADD COLUMN name TEXT" },
    {
      id: "0003_backfill_name",
      phase: "backfill",
      sql: "UPDATE demo SET name = name_old WHERE name IS NULL",
    },
    { id: "0004_drop_old", phase: "contract", sql: "ALTER TABLE demo DROP COLUMN name_old" },
  ],
};

describe.skipIf(!DB)("マイグレーション（DATABASE_URL 必須）", () => {
  test("未適用の DB ではエージェントが起動しない（起動時 CREATE TABLE をしない）", async () => {
    await withEmptyDatabase(async (url) => {
      await expect(
        createAgent({ agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun" }, [
          createPgAuditPlugin({ connectionString: url }),
        ]),
      ).rejects.toThrow(/pnpm migrate/);

      // 起動に失敗した後もテーブルは作られていない
      const pool = testPool(url);
      try {
        const res = await pool.query<{ reg: string | null }>(
          "SELECT to_regclass('event_log') AS reg",
        );
        expect(res.rows[0]?.reg).toBeNull();
      } finally {
        await pool.end();
      }
    });
  });

  test("適用すると起動できる。適用は冪等で、同時実行でも二重適用しない", async () => {
    await withEmptyDatabase(async (url) => {
      const poolA = testPool(url);
      const poolB = testPool(url);
      try {
        // 同時に走らせても advisory lock で直列化され、合計で1回ずつしか適用されない
        const [a, b] = await Promise.all([
          runMigrations(poolA, [AUDIT_MIGRATIONS]),
          runMigrations(poolB, [AUDIT_MIGRATIONS]),
        ]);
        expect(a.applied.length + b.applied.length).toBe(AUDIT_MIGRATIONS.migrations.length);

        const status = await migrationStatus(poolA, [AUDIT_MIGRATIONS]);
        expect(status.pending).toHaveLength(0);
        expect(status.drifted).toHaveLength(0);
        expect(status.applied.map((x) => x.id)).toEqual(
          AUDIT_MIGRATIONS.migrations.map((m) => m.id),
        );

        // 再実行しても何も起きない
        expect((await runMigrations(poolA, [AUDIT_MIGRATIONS])).applied).toHaveLength(0);
        await expect(assertSchemaReady(poolA, [AUDIT_MIGRATIONS])).resolves.toBeUndefined();
      } finally {
        await poolA.end();
        await poolB.end();
      }

      // 同じ DB でエージェントが起動する
      const agent = await createAgent(
        { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun" },
        [createPgAuditPlugin({ connectionString: url })],
      );
      await agent.destroy();
    });
  });

  test("適用済みマイグレーションを書き換えたら止まる", async () => {
    await withEmptyDatabase(async (url) => {
      const pool = testPool(url);
      try {
        await runMigrations(pool, [AUDIT_MIGRATIONS]);

        const tampered: MigrationSet = {
          namespace: AUDIT_MIGRATIONS.namespace,
          migrations: AUDIT_MIGRATIONS.migrations.map((m) => ({
            ...m,
            sql: `${m.sql}\n-- 後から書き換えた`,
          })),
        };
        const status = await migrationStatus(pool, [tampered]);
        expect(status.drifted).toHaveLength(1);
        await expect(assertSchemaReady(pool, [tampered])).rejects.toThrow(/変更されています/);
        await expect(runMigrations(pool, [tampered])).rejects.toThrow(/変更されています/);
      } finally {
        await pool.end();
      }
    });
  });

  test("expand→backfill→contract が3段で回る（contract は明示指定が要る）", async () => {
    await withEmptyDatabase(async (url) => {
      const pool = testPool(url);
      try {
        // 1段目: 旧構造のまま新構造を足す
        const first = await runMigrations(pool, [RENAME_DEMO], { through: "expand" });
        expect(first.applied.map((m) => m.id)).toEqual(["0001_create", "0002_add_name"]);
        expect(first.deferred.map((m) => m.id)).toEqual(["0003_backfill_name", "0004_drop_old"]);
        await pool.query("INSERT INTO demo (name_old) VALUES ('旧データ')");

        // 2段目: backfill まで。旧列はまだ残っている（旧コードが読める）
        const second = await runMigrations(pool, [RENAME_DEMO]);
        expect(second.applied.map((m) => m.id)).toEqual(["0003_backfill_name"]);
        expect(second.deferred.map((m) => m.id)).toEqual(["0004_drop_old"]);
        const rows = await pool.query<{ name: string; name_old: string }>(
          "SELECT name, name_old FROM demo",
        );
        expect(rows.rows[0]).toEqual({ name: "旧データ", name_old: "旧データ" });

        // contract が未適用でも起動は止めない（新コードは動くため）
        await expect(assertSchemaReady(pool, [RENAME_DEMO])).resolves.toBeUndefined();

        // 3段目: 新コードが行き渡ってから旧構造を撤去する
        const third = await runMigrations(pool, [RENAME_DEMO], { through: "contract" });
        expect(third.applied.map((m) => m.id)).toEqual(["0004_drop_old"]);
        await expect(pool.query("SELECT name_old FROM demo")).rejects.toThrow();
        const after = await pool.query<{ name: string }>("SELECT name FROM demo");
        expect(after.rows[0]?.name).toBe("旧データ");
      } finally {
        await pool.end();
      }
    });
  });
});
