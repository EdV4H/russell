/**
 * コアの外から `event_log` へ1件追記するための入口。
 *
 * なぜ要るか: 夜間バッチ（worker）は **app とは別プロセス**で、AgentContext も
 * AuditRegistry も持たない。しかし本棚の整理のように**状態を変える行為**をするので、
 * 「全アクションが残る」を worker でも満たす必要がある（§6.1）。
 *
 * これは sink ではなく単発の追記。fail-closed の判定（残せなければ実行しない）は
 * 呼び出し側の責任で、ここは失敗を握り潰さず throw する。
 */

import type pg from "pg";

export interface AuditAppendInput {
  agentId: string;
  configVersion: string;
  actor: string;
  action: string;
  payload?: Record<string, unknown>;
  /**
   * 来歴。既定は `untrusted`。
   *
   * 既定を厳しい側にしてあるのは、バッチが触るもの（本棚・メモ）の中身が
   * **他者の Slack 発言に由来する**ため。個体自身の行為であることを理由に
   * trusted へ昇格させない（§12-3）。
   */
  trustLabel?: "trusted" | "untrusted";
}

/** `event_log` に1件追記する。本文（メッセージ本体）を payload に入れないこと（A1-5）。 */
export async function appendAuditEvent(pool: pg.Pool, input: AuditAppendInput): Promise<void> {
  await pool.query(
    `INSERT INTO event_log (ts, agent_id, config_version, actor, action, payload, trust_label)
     VALUES (now(), $1, $2, $3, $4, $5::jsonb, $6)`,
    [
      input.agentId,
      input.configVersion,
      input.actor,
      input.action,
      JSON.stringify(input.payload ?? {}),
      input.trustLabel ?? "untrusted",
    ],
  );
}
