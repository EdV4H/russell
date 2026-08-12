/**
 * 死活（#78）。要 DATABASE_URL。
 *
 * サーバーでは**落ちても誰も気づきません**。このセッション中だけでも Bob は何度も黙り、
 * 相手からはどれも同じに見えました（返事が来ない）。
 *
 * 難しいのは「**監視するものが自分自身を監視できない**」こと。だから**お互いを見る**形にした。
 * ここで固めたいのは、**毎回同じことを言わない**ことと、**復帰したらまた言えるようになる**こと。
 */

import { STALE_MS, beat, heartbeats, takeStale } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

/** 最後の鼓動を過去にずらす（止まった状態を作る）。 */
async function age(pool: pg.Pool, agentId: string, component: string, minutes: number) {
  await pool.query(
    `UPDATE component_heartbeats SET beat_at = now() - ($3 || ' minutes')::interval
      WHERE agent_id = $1 AND component = $2`,
    [agentId, component, String(minutes)],
  );
}

describe.skipIf(!DB)("死活（DATABASE_URL 必須）", () => {
  test("鼓動は行を増やさない（1コンポーネント1行を上書き）", async () => {
    const agentId = `live-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });

    await beat(pool, agentId, "agent");
    await beat(pool, agentId, "agent");
    await beat(pool, agentId, "agent");

    // event_log に積むと1日288行になる。#26 で片付けた問題を作り直さない
    expect(await heartbeats(pool, agentId)).toHaveLength(1);
    await pool.end();
  });

  test("途絶えたら見つかる。**2回目は言わない**", async () => {
    const agentId = `live-stale-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await beat(pool, agentId, "agent");
    await age(pool, agentId, "agent", 30);

    const first = await takeStale(pool, agentId);
    expect(first.map((s) => s.component)).toEqual(["agent"]);
    expect(first[0]?.ageMs).toBeGreaterThan(STALE_MS);

    // 毎 tick 同じことを言わない
    expect(await takeStale(pool, agentId)).toEqual([]);
    await pool.end();
  });

  test("復帰したら、次に途絶えたときはまた言う", async () => {
    const agentId = `live-recover-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await beat(pool, agentId, "agent");
    await age(pool, agentId, "agent", 30);
    await takeStale(pool, agentId);

    await beat(pool, agentId, "agent"); // 復帰
    await age(pool, agentId, "agent", 30); // また止まる

    expect(await takeStale(pool, agentId)).toHaveLength(1);
    await pool.end();
  });

  test("自分は自分の途絶えを見つけられない（除外できる）", async () => {
    const agentId = `live-self-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await beat(pool, agentId, "dispatcher");
    await beat(pool, agentId, "agent");
    await age(pool, agentId, "dispatcher", 30);
    await age(pool, agentId, "agent", 30);

    // dispatcher 自身は除外して見る。**自分の死は自分では言えない**
    const stale = await takeStale(pool, agentId, ["dispatcher"]);
    expect(stale.map((s) => s.component)).toEqual(["agent"]);
    await pool.end();
  });

  test("遅れただけでは騒がない", async () => {
    const agentId = `live-fresh-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await beat(pool, agentId, "agent");
    await age(pool, agentId, "agent", 5); // 5分。tick より長いが閾値未満

    expect(await takeStale(pool, agentId)).toEqual([]);
    await pool.end();
  });

  test("他の個体の途絶えは混ざらない", async () => {
    const a = `live-a-${Date.now()}`;
    const b = `live-b-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await beat(pool, a, "agent");
    await beat(pool, b, "agent");
    await age(pool, a, "agent", 30);

    expect(await takeStale(pool, b)).toEqual([]);
    expect(await takeStale(pool, a)).toHaveLength(1);
    await pool.end();
  });
});
