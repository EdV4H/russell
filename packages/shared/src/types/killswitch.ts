/**
 * キルスイッチの型。設計書 §12-4（キルスイッチ）/ §12-7（fail-closed・別経路）、
 * 運用は [`docs/preparation/operations/kill-switch.md`](../../../../docs/preparation/operations/kill-switch.md)。
 *
 * 段階を2系統持つ:
 * - **通常経路（レベル1/2）** = `/russell stop [--all]`。DB に凍結状態を書く。
 *   自発行動を凍結し、mention への最低限の応答（「いま止まっています」）だけ残す。
 * - **別経路（レベル3）** = env `RUSSELL_KILL=1`。DB を読めなくても効く。**完全沈黙**。
 *
 * 通常経路の永続化はプラグイン（`russell-plugin-killswitch-pg`）が持ち、コアは
 * この capability 契約だけを知る（plugin-first）。capability が無い構成では env だけが効く。
 */

/**
 * 凍結の段階。強い順に silent > stopped > none。
 * コアはこの値だけを見て振る舞いを決める（どこから来た凍結かは問わない）。
 */
export type FreezeLevel = "none" | "stopped" | "silent";

/** 凍結の範囲。`agent` = その個体だけ、`all` = 全個体。 */
export type StopScope = "agent" | "all";

/** 現在の凍結状態。停止していないときは `stopped: false` で他は null。 */
export interface StopState {
  stopped: boolean;
  /** どちらの範囲で止まっているか。`all` が優先（全体停止は個体の再開で解けない）。 */
  scope: StopScope | null;
  /** 発動者（Slack user id など）。 */
  by: string | null;
  /** 発動時刻（ISO8601）。 */
  at: string | null;
  /**
   * 理由。**運用記録であって監査 payload には入れない**（本文を監査へ流さない, A1-5）。
   * `/russell status` で読み返すためだけに保持する。
   */
  reason: string | null;
}

export interface StopInput {
  /** 対象個体。`scope: "all"` のときは無視される。 */
  agentId: string;
  scope: StopScope;
  /** 発動者。Slack user id 等。 */
  by: string;
  reason?: string;
}

/**
 * 通常経路（レベル1/2）の実体。
 *
 * `current()` は**副作用の直前に毎回呼ばれる**（§5.1「副作用の直前にモードとキルスイッチを再検査」）。
 * DB 障害などで読めないときは **throw する**こと。握り潰して「停止していない」を返してはいけない
 * （コアは throw を受けて完全沈黙へ倒す = fail-closed, §12-7）。
 */
export interface KillSwitchCapability {
  current(agentId: string): Promise<StopState>;
  stop(input: StopInput): Promise<StopState>;
  /** 解除。発動より慎重に行う（オーナー承認前提, kill-switch.md）。 */
  resume(input: Omit<StopInput, "reason">): Promise<StopState>;
}

/** services のキー。 */
export const KILL_SWITCH_SERVICE = "killSwitch";
