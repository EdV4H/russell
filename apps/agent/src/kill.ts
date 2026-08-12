/**
 * キルスイッチの CLI（#28）。**Slack を経由せずに発動・解除する。**
 *
 * これまで実際に使える手段は2つしかなかった:
 * - `/russell stop` — **Slack が死んでいたら使えない**
 * - `RUSSELL_KILL=1` — 再起動が要る（レベル3）
 *
 * 運用手順は「迷ったら発動する」と書いてあるのに、発動に SQL を書く必要がある状態だった。
 * サーバーで動かすと、この差はもっと効く（手元の psql が無い）。
 *
 *   node apps/agent/dist/kill.js status
 *   node apps/agent/dist/kill.js stop [--all|--agent=<個体>] [--reason "理由"]
 *   node apps/agent/dist/kill.js start [--all|--agent=<個体>] --by <名前>
 *
 * **これはレベル1/2（通常経路）。** DB が死んでいるときは効かないので、そのときは
 * レベル3（`RUSSELL_KILL=1` で再起動）を使う——2系統ある理由がそれ。
 */

import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { ALL_TARGET, readStopState } from "@edv4h/russell-plugin-killswitch-pg";
import pg from "pg";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function scopeAndTarget(selfAgentId: string): { scope: "all" | "agent"; target: string } {
  if (process.argv.includes("--all")) return { scope: "all", target: ALL_TARGET };
  const agent = process.argv.find((a) => a.startsWith("--agent="))?.slice("--agent=".length);
  return { scope: "agent", target: agent || selfAgentId };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[kill] DATABASE_URL が未設定です。");
    console.error(
      "[kill] DB が死んでいるなら、レベル3（RUSSELL_KILL=1 で再起動）を使ってください。",
    );
    process.exit(1);
  }
  const verb = process.argv[2];
  const selfAgentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const { scope, target } = scopeAndTarget(selfAgentId);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    if (verb === "status" || !verb) {
      const state = await readStopState(pool, selfAgentId);
      console.log(
        state.stopped
          ? `[kill] 凍結中（${state.scope === "all" ? "全個体" : "この個体"}） / 発動者: ${state.by} / ${state.at}${state.reason ? ` / 理由: ${state.reason}` : ""}`
          : "[kill] 稼働中（凍結なし）",
      );
      return;
    }

    if (verb !== "stop" && verb !== "start") {
      console.error(
        '[kill] 使い方: status | stop [--all|--agent=<個体>] [--reason "理由"] | start ... --by <名前>',
      );
      process.exit(64);
    }

    // 発動者は必ず残す。**解除は名前が要る**（誰が戻したか分からない解除を作らない）。
    // 発動は名前が無くても通す——「迷ったら発動する」を名前の有無で妨げない。
    const by =
      flag("--by") ?? process.env.RUSSELL_OPERATOR ?? (verb === "stop" ? "cli" : undefined);
    if (!by) {
      console.error(
        "[kill] 解除には --by <名前> か RUSSELL_OPERATOR が要ります（誰が戻したかを残すため）。",
      );
      process.exit(64);
    }

    if (verb === "stop") {
      const reason = flag("--reason")?.slice(0, 500) ?? null;
      // **先に止める。** 監査が残せなくても凍結は成立させる（止まらない方が危険）
      await pool.query(
        `INSERT INTO agent_stops (target, stopped, by_actor, reason)
         VALUES ($1, true, $2, $3)
         ON CONFLICT (target) DO UPDATE
           SET stopped = true, by_actor = EXCLUDED.by_actor, reason = EXCLUDED.reason, updated_at = now()`,
        [target, by, reason],
      );
      console.log(
        `[kill] 凍結しました（${scope === "all" ? "全個体" : target}）。自発行動は止まります。`,
      );
      await record(pool, selfAgentId, "killswitch.engaged", by, {
        scope,
        target,
        // 理由の本文は監査に入れない（A1-5）。長さだけ残す
        reasonLength: reason?.length ?? 0,
        via: "cli",
      });
      return;
    }

    // 解除は監査に残ってからでないとやらない（危険な方向の変更を追えなくしない, §12-7）
    const audited = await record(pool, selfAgentId, "killswitch.released", by, {
      scope,
      target,
      via: "cli",
    });
    if (!audited) {
      console.error("[kill] 監査が残せないため解除しません（fail-closed）。監査の復旧が先です。");
      process.exit(1);
    }
    await pool.query(
      `INSERT INTO agent_stops (target, stopped, by_actor, reason)
       VALUES ($1, false, $2, NULL)
       ON CONFLICT (target) DO UPDATE
         SET stopped = false, by_actor = EXCLUDED.by_actor, reason = NULL, updated_at = now()`,
      [target, by],
    );
    console.log(`[kill] 解除しました（${scope === "all" ? "全個体" : target}）。`);
  } finally {
    await pool.end();
  }
}

/** 監査へ1件。**失敗しても発動は止めない**（記録より凍結が先, §12-4）。 */
async function record(
  pool: pg.Pool,
  agentId: string,
  action: string,
  actor: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO event_log (ts, agent_id, config_version, actor, action, payload, trust_label)
       VALUES (now(), $1, $2, $3, $4, $5::jsonb, 'untrusted')`,
      [agentId, process.env.RUSSELL_CONFIG_VERSION ?? "v0", actor, action, JSON.stringify(payload)],
    );
    return true;
  } catch (err) {
    console.warn(
      `[kill] 監査に残せませんでした: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
