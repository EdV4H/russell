/**
 * dispatcher（§5.1）。**実行期限を迎えたルーティンを claim して走らせる。**
 *
 * 静的 cron を直接実行しない理由は復旧時の挙動にある。プロセスが3日止まっていたとき、
 * 溜まった分を全部やるのか、1回にまとめるのか、無かったことにするのかは**仕事の性質で違う**。
 * cron 自身はそれを決められないので、台帳に持って dispatcher が判断する。
 *
 * 二重実行の防止は2段階:
 * - **claim** は `FOR UPDATE SKIP LOCKED`。同時に走った dispatcher が同じ行を取らない
 * - **論理的な一意性**は `(agent_id, routine_id, scheduled_for)` の一意制約。
 *   claim をすり抜けても、同じ予定時刻の実行は1件しか作れない
 */

import {
  type CatchupPolicy,
  type RunStatus,
  leaseExpired,
  resolveCatchup,
} from "@edv4h/russell-core";
import parser from "cron-parser";
import type pg from "pg";

/** リースの寿命。これを超えて heartbeat が無ければ、別のプロセスが引き取ってよい。 */
export const LEASE_MS = 10 * 60 * 1000;

/** 取りこぼしを遡る上限。**止まっていた期間が長いほど、古い予定の価値は下がる。** */
const MAX_LOOKBACK_DAYS = 14;

export interface RoutineRow {
  agentId: string;
  routineId: string;
  cron: string;
  timezone: string;
  catchup: CatchupPolicy;
  lastScheduledFor: Date | null;
}

export interface ClaimedRun {
  runId: number;
  routineId: string;
  scheduledFor: Date;
  fence: number;
}

/**
 * その時点で「実行すべき予定時刻」を出す。
 *
 * 一度も走っていないルーティンは**直前の1回分だけ**を候補にする。登録した瞬間に
 * 過去の予定が大量に湧くのを防ぐため（登録＝今日から始める、が自然な期待）。
 */
export function dueOccurrences(routine: RoutineRow, now: Date): Date[] {
  const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const since =
    routine.lastScheduledFor && routine.lastScheduledFor > floor ? routine.lastScheduledFor : floor;

  const missed: Date[] = [];
  try {
    const it = parser.parseExpression(routine.cron, {
      currentDate: since,
      endDate: now,
      tz: routine.timezone,
    });
    while (it.hasNext()) {
      const next = it.next().toDate();
      if (next > now) break;
      // 同じ時刻を二度候補にしない（since が予定時刻そのものだった場合）
      if (routine.lastScheduledFor && next <= routine.lastScheduledFor) continue;
      missed.push(next);
    }
  } catch {
    // cron が壊れているルーティンは黙って走らせない。台帳の誤りは実行より前に直すべき
    return [];
  }

  // 初回は直前の1回だけ（登録時に過去分が湧かないように）
  const candidates = routine.lastScheduledFor ? missed : missed.slice(-1);
  return resolveCatchup({ missed: candidates, policy: routine.catchup });
}

/** 台帳から有効なルーティンを読む。 */
export async function loadRoutines(pool: pg.Pool, agentId: string): Promise<RoutineRow[]> {
  const res = await pool.query<{
    routine_id: string;
    cron: string;
    timezone: string;
    catchup: string;
    last_scheduled_for: Date | null;
  }>(
    `SELECT routine_id, cron, timezone, catchup, last_scheduled_for
       FROM routines WHERE agent_id = $1 AND enabled ORDER BY routine_id`,
    [agentId],
  );
  return res.rows.map((r) => ({
    agentId,
    routineId: r.routine_id,
    cron: r.cron,
    timezone: r.timezone,
    catchup: (["skip", "coalesce", "replay_once"] as const).includes(r.catchup as CatchupPolicy)
      ? (r.catchup as CatchupPolicy)
      : "coalesce",
    lastScheduledFor: r.last_scheduled_for,
  }));
}

/**
 * 実行を1件 claim する。**取れなければ undefined**（他のプロセスが持っている、
 * または既に実行済み）。
 */
export async function claimRun(
  pool: pg.Pool,
  agentId: string,
  routineId: string,
  scheduledFor: Date,
): Promise<ClaimedRun | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 既存の実行を見る。**終わっているなら二度と走らせない**
    const existing = await client.query<{
      id: string;
      status: string;
      heartbeat_at: Date | null;
      fence: string;
    }>(
      `SELECT id::text, status, heartbeat_at, fence::text FROM routine_runs
        WHERE agent_id = $1 AND routine_id = $2 AND scheduled_for = $3
        FOR UPDATE SKIP LOCKED`,
      [agentId, routineId, scheduledFor],
    );

    const row = existing.rows[0];
    if (row) {
      if (row.status !== "claimed") {
        await client.query("ROLLBACK");
        return undefined; // 済んでいる
      }
      // claimed のまま heartbeat が途絶えている＝実行者が落ちた。引き取る
      if (!leaseExpired(row.heartbeat_at, new Date(), LEASE_MS)) {
        await client.query("ROLLBACK");
        return undefined; // 生きている実行者がいる
      }
      const fence = Number(row.fence) + 1;
      await client.query("UPDATE routine_runs SET heartbeat_at = now(), fence = $2 WHERE id = $1", [
        row.id,
        fence,
      ]);
      await client.query("COMMIT");
      return { runId: Number(row.id), routineId, scheduledFor, fence };
    }

    // 新規。一意制約があるので、同時に来ても1件しか入らない
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO routine_runs (agent_id, routine_id, scheduled_for, status, heartbeat_at)
       VALUES ($1, $2, $3, 'claimed', now())
       ON CONFLICT (agent_id, routine_id, scheduled_for) DO NOTHING
       RETURNING id::text`,
      [agentId, routineId, scheduledFor],
    );
    await client.query("COMMIT");
    const id = inserted.rows[0]?.id;
    return id ? { runId: Number(id), routineId, scheduledFor, fence: 1 } : undefined;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** 実行中であることを知らせる（長い処理でリースを切らさない）。 */
export async function heartbeat(pool: pg.Pool, runId: number, fence: number): Promise<void> {
  // **古い書き手を弾く**（fencing token）。引き取られた後の更新は通さない
  await pool.query("UPDATE routine_runs SET heartbeat_at = now() WHERE id = $1 AND fence = $2", [
    runId,
    fence,
  ]);
}

/** 実行を終える。`last_scheduled_for` を進めるのは**成功したときだけ**。 */
export async function finishRun(
  pool: pg.Pool,
  run: ClaimedRun,
  agentId: string,
  status: RunStatus,
  detail?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE routine_runs SET status = $3, detail = $4, finished_at = now()
        WHERE id = $1 AND fence = $2`,
      [run.runId, run.fence, status, detail ?? null],
    );
    if (status !== "failed") {
      // 失敗した予定時刻は進めない。次の tick で取り直せるようにしておく
      await client.query(
        `UPDATE routines SET last_scheduled_for = GREATEST(coalesce(last_scheduled_for, $3), $3)
          WHERE agent_id = $1 AND routine_id = $2`,
        [agentId, run.routineId, run.scheduledFor],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
