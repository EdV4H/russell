/**
 * dispatcher の claim（§5.1）。要 DATABASE_URL。
 *
 * 二重実行を防ぐのは2段階:
 * - claim は `FOR UPDATE SKIP LOCKED`。同時に走った dispatcher が同じ行を取らない
 * - **論理的な一意性**は `(agent_id, routine_id, scheduled_for)` の一意制約
 *
 * ここで確かめたいのは後者。claim をすり抜けても、**同じ予定時刻の実行は1件しか作れない**。
 */

import { claimRun, finishRun } from "@edv4h/russell-plugin-routines-pg";
import pg from "pg";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;
const at = new Date("2026-08-12T18:00:00Z");

describe.skipIf(!DB)("dispatcher の claim（DATABASE_URL 必須）", () => {
  test("同じ予定時刻は1回しか claim できない", async () => {
    const agentId = `dispatch-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });

    const first = await claimRun(pool, agentId, "journal", at);
    const second = await claimRun(pool, agentId, "journal", at);

    expect(first).toBeDefined();
    // **2つ目は取れない。** 生きている実行者がいる
    expect(second).toBeUndefined();

    await pool.end();
  });

  test("同時に走らせても1つしか取れない", async () => {
    const agentId = `dispatch-race-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimRun(pool, agentId, "journal", at)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    await pool.end();
  });

  test("終わった実行は二度と claim できない", async () => {
    const agentId = `dispatch-done-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });

    const run = await claimRun(pool, agentId, "journal", at);
    if (!run) throw new Error("claim できませんでした");
    await finishRun(pool, run, agentId, "succeeded");

    expect(await claimRun(pool, agentId, "journal", at)).toBeUndefined();
    await pool.end();
  });

  test("成功したら予定時刻が進む。失敗したら進めない（次の tick で取り直せる）", async () => {
    const agentId = `dispatch-adv-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query(
      "INSERT INTO routines (agent_id, routine_id, cron) VALUES ($1,'journal','0 3 * * *')",
      [agentId],
    );

    const failed = await claimRun(pool, agentId, "journal", at);
    if (!failed) throw new Error("claim できませんでした");
    await finishRun(pool, failed, agentId, "failed", "落ちた");
    const afterFail = await pool.query<{ last_scheduled_for: Date | null }>(
      "SELECT last_scheduled_for FROM routines WHERE agent_id=$1",
      [agentId],
    );
    expect(afterFail.rows[0]?.last_scheduled_for).toBeNull();

    const ok = await claimRun(pool, agentId, "journal", new Date("2026-08-13T18:00:00Z"));
    if (!ok) throw new Error("claim できませんでした");
    await finishRun(pool, ok, agentId, "succeeded");
    const afterOk = await pool.query<{ last_scheduled_for: Date }>(
      "SELECT last_scheduled_for FROM routines WHERE agent_id=$1",
      [agentId],
    );
    expect(afterOk.rows[0]?.last_scheduled_for?.toISOString()).toBe("2026-08-13T18:00:00.000Z");

    await pool.end();
  });

  test("実行者が落ちたら別のプロセスが引き取れる（fence が上がる）", async () => {
    const agentId = `dispatch-lease-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });

    const first = await claimRun(pool, agentId, "journal", at);
    if (!first) throw new Error("claim できませんでした");
    // heartbeat を過去にする＝実行者が落ちた状態
    await pool.query(
      "UPDATE routine_runs SET heartbeat_at = now() - interval '1 hour' WHERE id=$1",
      [first.runId],
    );

    const taken = await claimRun(pool, agentId, "journal", at);
    expect(taken?.fence).toBe(first.fence + 1);

    // **古い実行者の書き込みは通らない**（fencing token）
    await finishRun(pool, first, agentId, "succeeded");
    const row = await pool.query<{ status: string }>(
      "SELECT status FROM routine_runs WHERE id=$1",
      [first.runId],
    );
    expect(row.rows[0]?.status).toBe("claimed"); // 古い fence の更新は無視された

    await pool.end();
  });
});
