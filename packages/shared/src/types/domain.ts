/**
 * Russell ドメイン型（提案仕様の骨格）。
 * 出典: docs/reference/32-domain-types.md。P0 で使うものを中心に、後続フェーズの型も枠だけ置く。
 * すべて「実装フェーズで確定」する叩き台。
 */

/** ツールの効果分類（§9.2）。未分類・未知は Policy Gate で default deny。 */
export type EffectClass =
  | "read"
  | "internal_write"
  | "external_write"
  | "external_send"
  | "irreversible_write";

/** 書き込み結果（§9.2）。unknown の blind retry は禁止。 */
export type OperationResult = "succeeded" | "rejected" | "unknown";

/** ソース取得の完全性契約（§6.3）。「動きなし」と言えるのは complete のときだけ。 */
export interface SourceResult<T = unknown> {
  status: "complete" | "partial" | "failed" | "unauthorized";
  freshness?: string; // ISO8601。取得時刻
  data?: T;
}

/** 信頼ラベル（§6.1・§12-3）。外部由来テキストは untrusted。 */
export type TrustLabel = "trusted" | "untrusted";

/** 実行モード（§6.5）。 */
export type Mode = "off" | "dryrun" | "live";

/** 気質（§6.1）。個体固有 config。人格プロンプト生成と気づき閾値の両方へ流れる。 */
export interface Temperament {
  name: string;
  tone: string;
  backstory?: string;
  proactivity: number; // 0-1
  daily_speak_cap: number;
  curiosity: number; // 0-1
  reaction_rate: number; // 0-1
}

/** Finding 状態（§6.2）。P3 で本格利用。 */
export type FindingState = "detected" | "notified" | "acknowledged" | "resolved" | "suppressed";

/** 気づきの一級データ（§6.2）。P3。 */
export interface Finding {
  id: string;
  agentId: string;
  findingKey: string; // kind+主体+理由から決定的に生成
  kind: string;
  reasonCode: string;
  facts: Record<string, unknown>;
  evidence: Record<string, unknown>;
  proposedAction?: string;
  state: FindingState;
  configVersion: string;
  detectedAt: string;
}

/** 受信メッセージ（surface → コア）。既定で untrusted。 */
export interface InboundMessage {
  surfaceId: string;
  contextId: string; // slack thread_ts / task id 等
  author: string;
  text: string;
  trustLabel: TrustLabel;
  isMention: boolean;
  raw?: unknown;
}

/** 送信メッセージ（コア → surface）。冪等キー対応。 */
export interface OutboundMessage {
  contextId: string;
  text: string;
  idempotencyKey?: string;
}

export interface DeliveryResult {
  status: OperationResult;
  detail?: string;
}

/** HITL 承認要求／結果（P2 以降で本格利用）。 */
export interface ApprovalRequest {
  contextId: string;
  summary: string;
  previewText?: string;
}
export interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
}

/** スコープ付き事前承認（§12-2）。 */
export interface ScopedPreApproval {
  operation: string;
  target: string;
  configVersion: string;
  maxCount: number;
  expiresAt: string;
}
