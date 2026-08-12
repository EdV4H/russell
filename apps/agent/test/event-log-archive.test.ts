/**
 * 監査ログの追記専用と、退避のための穴（#26）。要 DATABASE_URL。
 *
 * `event_log` は唯一増え続けるテーブルで、しかも削除経路を自分で塞いである。
 * 埋まると「監査に書けない → Policy Gate が deny → 応答も記憶も止まる」に連鎖する。
 *
 * 方針は「削除しない」なので、**消すのではなく外へ出す**。そのための穴を1つだけ開けた。
 * ここで確かめたいのは、**穴を開けたことで追記専用が壊れていないこと**。
 */

import pg from "pg";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

async function seed(pool: pg.Pool, agentId: string, ts: string) {
  await pool.query(
    `INSERT INTO event_log (ts, agent_id, config_version, actor, action, payload, trust_label)
     VALUES ($2::timestamptz, $1, 'v0', $1, 'test.event', '{}'::jsonb, 'trusted')`,
    [agentId, ts],
  );
}

describe.skipIf(!DB)("event_log の追記専用（DATABASE_URL 必須）", () => {
  test("ふつうの DELETE は拒否される", async () => {
    const agentId = `archive-del-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await seed(pool, agentId, "2026-01-01T00:00:00Z");

    await expect(
      pool.query("DELETE FROM event_log WHERE agent_id = $1", [agentId]),
    ).rejects.toThrow(/append-only/);

    await pool.end();
  });

  test("UPDATE は退避中でも拒否される（書き換えに正当な用途は無い）", async () => {
    const agentId = `archive-upd-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await seed(pool, agentId, "2026-01-01T00:00:00Z");

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL russell.archive = 'on'");
    await expect(
      client.query("UPDATE event_log SET actor = 'x' WHERE agent_id = $1", [agentId]),
    ).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  });

  test("退避中だけ DELETE が通る", async () => {
    const agentId = `archive-ok-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await seed(pool, agentId, "2026-01-01T00:00:00Z");

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL russell.archive = 'on'");
    const res = await client.query("DELETE FROM event_log WHERE agent_id = $1", [agentId]);
    await client.query("COMMIT");
    client.release();

    expect(res.rowCount).toBe(1);
    await pool.end();
  });

  test("退避の指定は SET LOCAL なので、トランザクションを抜けると効かない", async () => {
    const agentId = `archive-scope-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await seed(pool, agentId, "2026-01-01T00:00:00Z");

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL russell.archive = 'on'");
    await client.query("COMMIT");
    // **穴が開きっぱなしにならない**。同じ接続でも、抜けたら元の規律に戻る
    await expect(
      client.query("DELETE FROM event_log WHERE agent_id = $1", [agentId]),
    ).rejects.toThrow(/append-only/);
    client.release();
    await pool.end();
  });
});
