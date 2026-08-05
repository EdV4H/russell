/**
 * キルスイッチ通常経路（レベル1/2）: 凍結状態を Postgres の `agent_stops` に持つ。
 * 設計書 §12-4、運用は docs/preparation/operations/kill-switch.md。
 *
 * コアは `KillSwitchCapability` 契約しか知らない（plugin-first）。この capability が
 * 無い構成（オフライン stack）では env `RUSSELL_KILL`（レベル3）だけが効く。
 *
 * 監査の順序が**発動と解除で非対称**なのが要点:
 * - **発動**は先に適用し、監査は後（残らなくても止める）。監査が壊れているときこそ
 *   止めたいのに、「監査が残せないので止められません」では守れない。
 * - **解除**は監査に残ってからでないと行わない。危険な方向（凍結 → 通常運転）の変更が
 *   誰にも追えないまま起きるのを防ぐ（「解除は発動より慎重に」kill-switch.md）。
 */

import { assertAutoMigrateAllowed, assertSchemaReady, runMigrations } from "@edv4h/russell-migrate";
import type {
  AgentContext,
  AuditRegistry,
  KillSwitchCapability,
  RussellPlugin,
  StopInput,
  StopScope,
  StopState,
} from "@edv4h/russell-shared";
import { KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";
import pg from "pg";
import { ALL_TARGET, KILLSWITCH_MIGRATIONS } from "./migrations.js";

/** 理由文の保存上限。運用メモであって本文置き場ではない。 */
const REASON_MAX = 500;

/**
 * 個体 id の形。**Slack の入力がそのまま DB のキーになる**ので、ここで狭く縛る（§12-3）。
 * パラメータ化クエリで SQL としては安全だが、来歴不明の文字列を識別子として通さない。
 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PgKillSwitchOptions {
  /** 接続文字列。未指定なら env DATABASE_URL。 */
  connectionString?: string;
  /**
   * dev/test 用に起動時マイグレーションを走らせる。本番（NODE_ENV=production）では拒否される。
   * 既定 false ＝ **DDL は流さず「適用済みか」を確認するだけ**（§11）。
   */
  autoMigrate?: boolean;
}

interface StopRow {
  target: string;
  stopped: boolean;
  by_actor: string;
  reason: string | null;
  updated_at: Date;
}

const NOT_STOPPED: StopState = { stopped: false, scope: null, by: null, at: null, reason: null };

function targetOf(scope: StopScope, agentId: string): string {
  if (scope === "all") return ALL_TARGET;
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`killswitch: 個体 id の形式が不正です: "${agentId}"`);
  }
  return agentId;
}

function toState(row: StopRow): StopState {
  return {
    stopped: row.stopped,
    scope: row.target === ALL_TARGET ? "all" : "agent",
    by: row.by_actor,
    at: row.updated_at.toISOString(),
    reason: row.reason,
  };
}

export function createPgKillSwitchPlugin(options: PgKillSwitchOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-killswitch-pg",
    name: "Postgres Kill Switch (agent_stops)",
    async setup(ctx: AgentContext) {
      const pool = new pg.Pool({
        connectionString: options.connectionString ?? process.env.DATABASE_URL,
      });

      try {
        if (options.autoMigrate) {
          assertAutoMigrateAllowed(KILLSWITCH_MIGRATIONS.namespace);
          await runMigrations(pool, [KILLSWITCH_MIGRATIONS]);
        } else {
          await assertSchemaReady(pool, [KILLSWITCH_MIGRATIONS]);
        }
      } catch (err) {
        await pool.end();
        throw err;
      }

      const capability = createCapability(pool, ctx.audit);
      ctx.services.provide<KillSwitchCapability>(KILL_SWITCH_SERVICE, capability);

      return async () => {
        await pool.end();
      };
    },
  };
}

/**
 * 現在の凍結状態を読む。**エラーは握り潰さず投げる**（呼び出し側が fail-closed へ倒す, §12-7）。
 * 全体停止（`*`）を個体停止より優先して返す——個体の解除で全体停止が解けたように
 * 見えてはいけないため。
 */
export async function readStopState(pool: pg.Pool, agentId: string): Promise<StopState> {
  const res = await pool.query<StopRow>(
    `SELECT target, stopped, by_actor, reason, updated_at
       FROM agent_stops
      WHERE target IN ($1, $2) AND stopped
      ORDER BY (target = $2) DESC
      LIMIT 1`,
    [agentId, ALL_TARGET],
  );
  const row = res.rows[0];
  return row ? toState(row) : NOT_STOPPED;
}

/**
 * `createAgent` を経ない経路（worker の夜間バッチなど）のための単体判定。
 * 判定規則はコアの freeze.ts と同じ: **env が先**（DB を読めなくても効く）、次に DB、
 * 読めなければ「凍結中」に倒す（§12-7）。夜間バッチは自発行動そのものなので、
 * 凍結中に走らせない（§12-4「全自発行動を即凍結」）。
 */
export async function isFrozen(agentId: string, connectionString?: string): Promise<boolean> {
  if (process.env.RUSSELL_KILL === "1") return true;
  const pool = new pg.Pool({ connectionString: connectionString ?? process.env.DATABASE_URL });
  try {
    return (await readStopState(pool, agentId)).stopped;
  } catch (err) {
    console.error("[killswitch] 凍結状態を読めません。凍結中として扱います（fail-closed）。", err);
    return true;
  } finally {
    await pool.end();
  }
}

function createCapability(pool: pg.Pool, audit: AuditRegistry): KillSwitchCapability {
  const current = (agentId: string) => readStopState(pool, agentId);

  async function write(target: string, stopped: boolean, by: string, reason: string | null) {
    const res = await pool.query<StopRow>(
      `INSERT INTO agent_stops (target, stopped, by_actor, reason, updated_at)
            VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (target) DO UPDATE
            SET stopped = EXCLUDED.stopped,
                by_actor = EXCLUDED.by_actor,
                reason = EXCLUDED.reason,
                updated_at = now()
         RETURNING target, stopped, by_actor, reason, updated_at`,
      [target, stopped, by, reason],
    );
    // RETURNING があるので必ず1行返る。
    return toState(res.rows[0] as StopRow);
  }

  return {
    current,

    async stop(input: StopInput): Promise<StopState> {
      const target = targetOf(input.scope, input.agentId);
      const reason = input.reason?.slice(0, REASON_MAX) ?? null;
      // 先に止める。監査が残せなくても凍結は成立させる（上のコメント参照）。
      const state = await write(target, true, input.by, reason);
      // 理由の本文は監査に入れない（A1-5）。長さだけ残して、本文は agent_stops 側で読む。
      await audit.record({
        actor: input.by, // 発動者。個体自身の行為ではない
        action: "killswitch.engaged",
        payload: { scope: input.scope, target, reasonLength: reason?.length ?? 0 },
        trustLabel: "untrusted", // 通信面（Slack）由来の要求＝来歴は untrusted のまま（§12-3）
      });
      return state;
    },

    async resume(input: Omit<StopInput, "reason">): Promise<StopState> {
      const target = targetOf(input.scope, input.agentId);
      // 解除は監査に残ってからでないとやらない（危険な方向の変更を追えなくしない）。
      const audited = await audit.record({
        actor: input.by,
        action: "killswitch.released",
        payload: { scope: input.scope, target },
        trustLabel: "untrusted",
      });
      if (!audited) {
        throw new Error(
          "killswitch: 監査が残せないため解除しません（fail-closed, §12-7）。監査の復旧が先です。",
        );
      }
      return await write(target, false, input.by, null);
    },
  };
}
