/**
 * 監査ログ（event_log）の型。設計書 §3.1 / §12、横断必須ゲート
 * 「全アクションが event_log に trust_label 付きで残る」（test-strategy §5）。
 *
 * 原則:
 * - **追記専用**。UPDATE/DELETE しない（privacy-and-memory-policy: `event_log: append_only`）。
 * - **来歴を残す**。他者の Slack 発言に起因するアクションは untrusted のまま記録する（§12-3）。
 * - **実装はプラグイン**。コアは AuditSink 契約だけを知り、永続化先（Postgres 等）は知らない。
 */

import type { TrustLabel } from "./domain.js";

/** event_log の1行（§3.1: ts / actor / action / payload / trust_label）。 */
export interface AuditEvent {
  /** ISO8601。コアが記録時刻を打つ。 */
  ts: string;
  /** 誰が: Slack user id（受信起因）または agentId（自発・ツール実行）。 */
  actor: string;
  /** 何を: ドット区切りの動詞（turn.received / tool.invoked / policy.denied …）。 */
  action: string;
  /** 文脈。機微情報は入れない（本文ではなく識別子と要約を入れる）。 */
  payload: Record<string, unknown>;
  /** 来歴（§12-3）。外部由来に起因するものは untrusted。 */
  trustLabel: TrustLabel;
  /** どの個体か。 */
  agentId: string;
  /** どの公開版設定で動いていたか（§6.1 pin）。 */
  configVersion: string;
}

/** コアが記録を投げる先。プラグインが `ctx.audit.registerSink()` で登録する。 */
export interface AuditSink {
  id: string;
  /** 追記に失敗したら throw する（コアが fail-closed へ倒すため、握り潰さない）。 */
  write(event: AuditEvent): Promise<void>;
}

/** コアが提供する監査ファシリティ。 */
export interface AuditRegistry {
  /** 永続化先を登録する。戻り値で解除。 */
  registerSink(sink: AuditSink): () => void;
  /**
   * 1件記録する。ts / agentId / configVersion はコアが補う。
   *
   * 戻り値は**この記録が残ったか**。false = sink が全滅していて監査が残っていない。
   * 「行為の前に記録する」呼び出し側は、この戻り値を見て false なら行為を中止する
   * （記録に失敗したその瞬間から fail-closed にする必要があるため、事前の healthy() だけでは足りない）。
   * sink 未登録の構成（オフライン）は障害ではないので true を返す。
   */
  record(event: AuditRecordInput): Promise<boolean>;
  /** 直近のイベント（テスト・調査用のインメモリリングバッファ）。永続化の代替ではない。 */
  recent(limit?: number): AuditEvent[];
  /** sink への追記が健全か。false なら fail-closed 側に倒れている。 */
  healthy(): boolean;
}

/** `record()` の入力。コアが補う項目を除いたもの。 */
export interface AuditRecordInput {
  actor: string;
  action: string;
  payload?: Record<string, unknown>;
  trustLabel: TrustLabel;
}
