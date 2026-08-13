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
  /**
   * 群れの中でどれだけ反応するか（0-1）。**返すかどうかの判定の傾き**に流れる。
   *
   * 低いほど「よほど自分宛でなければ黙る」、高いほど「関係がありそうなら答えてよい」。
   * 既定（0.4〜0.8）は現状の振る舞いのままで、外れたときだけ傾ける。
   */
  reaction_rate: number; // 0-1
  /**
   * 返信の長さ。**数値ではなく段階**にしてある。
   *
   * 兄弟の値（proactivity など）は閾値へ流れるので数値が要るが、これはプロンプトの文章に
   * なるだけである。0.63 と 0.71 の差を言葉にできない以上、**数値にすると持っていない精度を
   * 持っているふりになる**（判定のチューニングで、効くのは数値ではなく言葉だと分かった）。
   */
  verbosity?: "brief" | "normal" | "detailed";
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
  /** 発言者の識別子（Slack の user id 等）。**監査はこちらを使う**（安定した識別子）。 */
  author: string;
  /**
   * 発言者の表示名。**会話にはこちらを使う**。
   *
   * id のまま会話へ渡すと、モデルは相手が誰か分からないまま丁寧に振る舞おうとして
   * **名前を作る**（実際に起きた）。引けないときは undefined のままにして、
   * 人格プロンプト側で「知らない名前を作らない」と縛る。
   */
  authorName?: string;
  /**
   * この発言に出てくる人（発言者と mention された人）の id と名前。
   *
   * **表示名を記憶するためではない**（それは取り直せる, ADR 0008）。
   * 「このカルテはこの Slack ユーザーのこと」という**紐付け**を作るために使う。
   * 紐付けは Slack 側からは取れないので、こちらで持つ必要がある。
   */
  people?: { id: string; name: string }[];
  text: string;
  trustLabel: TrustLabel;
  isMention: boolean;
  /**
   * その通信面での**この発言自身**の参照（Slack なら ts）。リアクションの付け先。
   * contextId がスレッド単位なのに対し、これは1発言単位。任意（持てない通信面もある）。
   */
  messageId?: string;
  raw?: unknown;
}

/**
 * リアクションの意味（§10.1 の透明性）。**絵文字ではなく意味を渡す**——
 * 何で表すかは通信面の裁量（Slack なら 📝、CLI なら1行出す）。
 *
 * - `noted` — 書き留めた（自分が何をしたかの表明）
 * - `acknowledged` — **読んだ。ただし返すほどではない**（そこに居ることの表明）。
 *   黙るだけだと、落ちているのか読んで黙っているのかが人から区別できない
 */
export type ReactionKind = "noted" | "acknowledged";

/** リアクション要求（コア → surface）。 */
export interface ReactionRequest {
  contextId: string;
  /** 対象の発言（`InboundMessage.messageId`）。 */
  messageId: string;
  kind: ReactionKind;
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
