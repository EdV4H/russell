/**
 * dispatcher の実行プロセス（§5.1）。**worker に住む**。
 *
 *   pnpm --filter @edv4h/russell-worker dispatch          # 1回だけ tick
 *   pnpm --filter @edv4h/russell-worker dispatch --watch  # 常駐して定期 tick
 *
 * 「日報を毎朝出す」も「週次レビュー」も、cron を台帳に足すだけで増える。
 * **日報のためだけの cron を作らなかった**のはそのため——単発で作ると、
 * 定期タスクを足すときに別経路がもう1つできる。
 */

import type { RunStatus } from "@edv4h/russell-core";
import { appendAuditEvent, beat, takeStale } from "@edv4h/russell-plugin-audit-pg";
import { isFrozen } from "@edv4h/russell-plugin-killswitch-pg";
import {
  claimRun,
  dueOccurrences,
  finishRun,
  heartbeat,
  loadRoutines,
} from "@edv4h/russell-plugin-routines-pg";
import { createSlackPoster } from "@edv4h/russell-plugin-surface-slack";
import pg from "pg";
import { runJournalRoutine } from "./journal-routine.js";

/** tick の間隔。細かくしても意味は無い（分単位の cron を拾えれば足りる）。 */
const TICK_MS = 30_000;

/** ルーティン id → 実際の処理。**台帳に無い id は走らない**（未支給の装備と同じ考え方）。 */
const HANDLERS: Record<
  string,
  (scheduledFor: Date) => Promise<{ status: RunStatus; detail?: string }>
> = {
  journal: runJournalRoutine,
};

/**
 * 途絶えを管理チャンネルへ知らせる。**Slack が死んでいたらログにだけ残る**——
 * 知らせられないこと自体は止める理由にならない。
 */
async function reportStale(pool: pg.Pool, agentId: string): Promise<void> {
  // 自分の途絶えは自分では気づけない。**agent 側が見る**（お互いを見る形）
  const stale = await takeStale(pool, agentId, ["dispatcher"]);
  for (const s of stale) {
    const minutes = Math.round(s.ageMs / 60000);
    const text = `:warning: ${agentId} の \`${s.component}\` が ${minutes} 分応答していません（最後: ${s.beatAt.toISOString()}）`;
    console.warn(`[dispatch] ${text}`);
    await appendAuditEvent(pool, {
      agentId,
      configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
      actor: agentId,
      action: "liveness.stale",
      payload: { component: s.component, ageMs: s.ageMs },
      trustLabel: "trusted",
    });
    const channel = process.env.RUSSELL_ADMIN_CHANNEL;
    if (!channel) continue;
    try {
      await createSlackPoster().post(channel, text);
    } catch (err) {
      // 知らせられないことは記録して進む。**通知の失敗で監視を止めない**
      console.warn(`[dispatch] 管理チャンネルへ知らせられませんでした: ${String(err)}`);
    }
  }
}

async function tick(pool: pg.Pool, agentId: string): Promise<void> {
  // **生存の記録は凍結中でも打つ。** 止まっているのと死んでいるのは別（止めたのは人の判断）
  await beat(pool, agentId, "dispatcher");
  await reportStale(pool, agentId);

  // 自発行動そのものなので、凍結中は走らせない（§12-4）。
  // **tick ごとに見る**——起動時に1回見るだけだと、発動しても止まらない。
  if (await isFrozen(agentId)) return;

  for (const routine of await loadRoutines(pool, agentId)) {
    const handler = HANDLERS[routine.routineId];
    if (!handler) continue;

    for (const scheduledFor of dueOccurrences(routine, new Date())) {
      const run = await claimRun(pool, agentId, routine.routineId, scheduledFor);
      if (!run) continue; // 他のプロセスが持っている、または済んでいる

      const beat = setInterval(() => {
        void heartbeat(pool, run.runId, run.fence);
      }, 60_000);
      beat.unref();

      let result: { status: RunStatus; detail?: string };
      try {
        console.log(
          `[dispatch] ${routine.routineId} を実行します（予定 ${scheduledFor.toISOString()}）`,
        );
        result = await handler(scheduledFor);
      } catch (err) {
        result = { status: "failed", detail: err instanceof Error ? err.message : String(err) };
      } finally {
        clearInterval(beat);
      }

      await finishRun(pool, run, agentId, result.status, result.detail);
      await appendAuditEvent(pool, {
        agentId,
        configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
        actor: agentId,
        action: "routine.finished",
        payload: {
          routine: routine.routineId,
          scheduledFor: scheduledFor.toISOString(),
          status: result.status,
        },
        trustLabel: "trusted",
      });
      console.log(
        `[dispatch] ${routine.routineId}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[dispatch] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const watch = process.argv.includes("--watch");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (err) => console.error("[dispatch] Postgres 接続エラー:", err.message));

  try {
    await tick(pool, agentId);
    if (!watch) return;

    console.log(`[dispatch] 常駐します（${TICK_MS / 1000}秒ごと）。`);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        // tick の失敗で常駐が終わらないようにする。次の tick で取り直せる
        void tick(pool, agentId).catch((err) => console.error("[dispatch] tick 失敗:", err));
      }, TICK_MS);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          clearInterval(timer);
          resolve();
        });
      }
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
