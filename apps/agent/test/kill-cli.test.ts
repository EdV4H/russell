/**
 * キルスイッチの CLI（#28）。要 DATABASE_URL。
 *
 * これまで実際に使える発動手段は「Slack」か「再起動」しかなかった。運用手順は
 * 「**迷ったら発動する**」と書いてあるのに、発動に SQL を書く必要がある状態だった。
 * サーバーではその差がもっと効く（手元の psql が無い）。
 *
 * ここで確かめたいのは、CLI で書いた状態が**実際に効く**こと。
 * 記録だけ書いて止まっていない、が最悪なので。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isFrozen, readStopState } from "@edv4h/russell-plugin-killswitch-pg";
import pg from "pg";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);
const DB = process.env.DATABASE_URL;
const CLI = new URL("../dist/kill.js", import.meta.url).pathname;

async function kill(agentId: string, ...args: string[]) {
  const { stdout } = await run("node", [CLI, ...args], {
    env: { ...process.env, RUSSELL_AGENT_ID: agentId, DATABASE_URL: DB },
  });
  return stdout;
}

describe.skipIf(!DB)("キルスイッチの CLI（DATABASE_URL 必須）", () => {
  test("発動すると、実際に凍結される（記録だけではない）", async () => {
    const agentId = `kill-cli-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });

    await kill(agentId, "stop", "--reason", "テスト");
    // **状態として効いている**ことを、記録ではなく凍結判定で見る
    expect(await isFrozen(agentId, DB)).toBe(true);
    const state = await readStopState(pool, agentId);
    expect(state).toMatchObject({ stopped: true, reason: "テスト" });

    await pool.end();
  });

  test("発動は名前が無くても通る（迷ったら発動する）", async () => {
    const agentId = `kill-anon-${Date.now()}`;
    const out = await kill(agentId, "stop");
    expect(out).toContain("凍結しました");
    expect(await isFrozen(agentId, DB)).toBe(true);
  });

  test("解除には名前が要る（誰が戻したか分からない解除を作らない）", async () => {
    const agentId = `kill-noname-${Date.now()}`;
    await kill(agentId, "stop");

    await expect(
      run("node", [CLI, "start"], {
        env: { ...process.env, RUSSELL_AGENT_ID: agentId, DATABASE_URL: DB, RUSSELL_OPERATOR: "" },
      }),
    ).rejects.toThrow();
    // 失敗した後も凍結は続いている（**中途半端に解除されない**）
    expect(await isFrozen(agentId, DB)).toBe(true);
  });

  test("名前を付ければ解除できる", async () => {
    const agentId = `kill-release-${Date.now()}`;
    await kill(agentId, "stop");
    await kill(agentId, "start", "--by", "yusuke");

    expect(await isFrozen(agentId, DB)).toBe(false);
  });

  test("--all は全個体を止める", async () => {
    const agentId = `kill-all-${Date.now()}`;
    const other = `${agentId}-other`;
    await kill(agentId, "stop", "--all");

    // **自分以外も止まる**（target='*' を全個体が読む）
    expect(await isFrozen(other, DB)).toBe(true);
    await kill(agentId, "start", "--all", "--by", "yusuke");
    expect(await isFrozen(other, DB)).toBe(false);
  });

  test("発動と解除は監査に残る。理由の本文は残さない（A1-5）", async () => {
    const agentId = `kill-audit-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await kill(agentId, "stop", "--reason", "秘密の理由");

    const rows = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      "SELECT action, payload FROM event_log WHERE agent_id=$1 ORDER BY ts DESC",
      [agentId],
    );
    const engaged = rows.rows.find((r) => r.action === "killswitch.engaged");
    expect(engaged?.payload).toMatchObject({ via: "cli", reasonLength: "秘密の理由".length });
    expect(JSON.stringify(engaged?.payload)).not.toContain("秘密");

    await pool.end();
  });
});
