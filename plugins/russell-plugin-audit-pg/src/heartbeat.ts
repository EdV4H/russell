/**
 * 死活の記録と判定（#78）。
 *
 * サーバーでは**落ちても誰も気づきません**。このセッション中だけでも Bob は何度も黙り、
 * 相手からはどれも同じに見えました（返事が来ない）。#55 で拾い直しは入れましたが、
 * **落ちていることに気づく手段**は別に要ります。
 *
 * 難しいのは「**監視するものが自分自身を監視できない**」ことです。だから
 * **お互いを見る**形にしてあります: agent が止まったら dispatcher が気づき、
 * dispatcher が止まったら agent が気づく。両方同時に死ぬと誰も言いませんが、
 * それはプロセス管理（restart）の担当で、ここは「動いているのに壊れている」を捕まえます。
 */

import type pg from "pg";

/** 途絶えたとみなすまでの時間。tick より十分長くしないと、遅れただけで騒ぐ。 */
export const STALE_MS = 15 * 60 * 1000;

export interface StaleComponent {
  component: string;
  beatAt: Date;
  ageMs: number;
}

/** 生きていることを記録する。**行は増えない**（1コンポーネント1行を上書き）。 */
export async function beat(pool: pg.Pool, agentId: string, component: string): Promise<void> {
  await pool.query(
    `INSERT INTO component_heartbeats (agent_id, component, beat_at, alerted)
     VALUES ($1, $2, now(), false)
     ON CONFLICT (agent_id, component) DO UPDATE SET beat_at = now(), alerted = false`,
    [agentId, component],
  );
}

/**
 * 途絶えていて、**まだ通知していない**ものを返す。返した時点で通知済みにする。
 *
 * 通知済みの印を付けるのは、**毎 tick 同じことを言わない**ため。復帰すると
 * `beat` が印を戻すので、次に途絶えたときはまた言う。
 */
export async function takeStale(
  pool: pg.Pool,
  agentId: string,
  exclude: string[] = [],
  staleMs = STALE_MS,
): Promise<StaleComponent[]> {
  const res = await pool.query<{ component: string; beat_at: Date; age_ms: string }>(
    `UPDATE component_heartbeats SET alerted = true
      WHERE agent_id = $1 AND NOT alerted
        AND beat_at < now() - ($2::bigint || ' milliseconds')::interval
        AND NOT (component = ANY($3::text[]))
      RETURNING component, beat_at,
                (extract(epoch from now() - beat_at) * 1000)::bigint::text AS age_ms`,
    [agentId, staleMs, exclude],
  );
  return res.rows.map((r) => ({
    component: r.component,
    beatAt: r.beat_at,
    ageMs: Number(r.age_ms),
  }));
}

/** いまの状況（通知の有無に関わらず全部）。運用が見るため。 */
export async function heartbeats(pool: pg.Pool, agentId: string): Promise<StaleComponent[]> {
  const res = await pool.query<{ component: string; beat_at: Date; age_ms: string }>(
    `SELECT component, beat_at, (extract(epoch from now() - beat_at) * 1000)::bigint::text AS age_ms
       FROM component_heartbeats WHERE agent_id = $1 ORDER BY component`,
    [agentId],
  );
  return res.rows.map((r) => ({
    component: r.component,
    beatAt: r.beat_at,
    ageMs: Number(r.age_ms),
  }));
}

/**
 * 前回の一打（#124）。**今回の分で上書きする前に読む。**
 *
 * `beat` は1行を上書きしていく形なので、打ってから読むと「たった今」しか返らない。
 * ここが順序に依存するのは気持ち悪いが、行を増やさない設計（1コンポーネント1行）と
 * 引き換えである——毎回1行足すと、5分ごとに1日288行になる。
 *
 * 取れなければ `undefined`。**「初めての起動」と「読めなかった」を同じに扱う**——
 * どちらも「前回がいつまでかは言えない」であり、そのときは既定の窓に倒す方が安全である。
 */
export async function lastBeat(
  pool: pg.Pool,
  agentId: string,
  component: string,
): Promise<Date | undefined> {
  try {
    const res = await pool.query<{ beat_at: Date }>(
      "SELECT beat_at FROM component_heartbeats WHERE agent_id = $1 AND component = $2",
      [agentId, component],
    );
    return res.rows[0]?.beat_at;
  } catch {
    return undefined;
  }
}
