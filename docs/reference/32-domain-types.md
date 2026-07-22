# リファレンス: ドメイン型（提案）

契約 [`30-russell-plugin-contract.md`](./30-russell-plugin-contract.md) と各ガイドが参照する共有ドメイン型の定義。

> [!NOTE] 提案仕様（実装時に `@edv4h/russell-shared` で確定）
> docs-only 段階の提案。実際のコードは未作成。フィールドは設計書 `human-like-agent-design.md`（§6.1/§6.2/§9/§12）を写したもの。差異があれば設計書を正とする。

## EffectClass — 効果分類

全ツールに付ける効果分類（設計書 §9.2）。`danger_level` はこれから導出する。未分類・未知リソースはコアが default deny。

```ts
export type EffectClass =
  | "read"                // 読み取りのみ（danger 0）
  | "internal_write"      // 記憶・内部状態への書込み（danger 0–1）
  | "external_write"      // 外部システムへの作成/更新（danger 2, 毎回 HITL）
  | "external_send"       // 対外送信: メッセージ・メール（danger 2）
  | "irreversible_write"; // 不可逆: 削除・本番反映（danger 3）
```

## OperationResult — 書き込み結果

書き込みの「結果不明」を一級で扱う（設計書 §9.2）。`unknown` の blind retry は禁止（idempotency key + read-after-write で解決）。

```ts
export interface OperationResult {
  status: "succeeded" | "rejected" | "unknown";
  dedup?: boolean;          // idempotency key で二重実行を吸収した
  idempotencyKey?: string;
  detail?: string;
}
```

## SourceResult — 完全性契約

全ソース取得は必ず status と freshness を返す（設計書 §6.3）。「動きなし」と言ってよいのは `complete` のときだけ。

```ts
export interface SourceResult<T = unknown> {
  status: "complete" | "partial" | "failed" | "unauthorized";
  data: T;
  freshness: string;        // ISO8601。いつ時点のデータか
  missing?: string[];       // partial のとき、取得できなかった範囲
}
```

## Finding — 気づきレコード

事実 + 根拠 + 提案アクションを持つ永続レコード（設計書 §6.2 のテーブルを写像）。

```ts
export interface Finding {
  id: string;
  agentId: string;
  finding_key: string;        // kind+主体+理由から決定的に生成（dedup 恒等キー）
  kind: string;               // "deadline_risk" | "platform_bug" | "doc_drift" | ...
  reason_code: string;        // 判定理由の機械可読コード
  facts: Fact[];              // 導出に使った事実（値 + 取得元 + 取得時刻）
  evidence: EvidenceRef[];    // 根拠へのソース参照（Slack permalink 等。PII は入れない）
  proposed_action?: string;
  state: FindingState;
  config_version: string;     // どの設定版で出た気づきか（再現性）
  detected_at: string;        // ISO8601
}

export interface Fact {
  key: string;
  value: string;
  source: string;             // 取得元（例 "notion:task/T-123"）
  observed_at: string;        // 取得時刻（ISO8601）
}
export interface EvidenceRef {
  ref: string;                // permalink 等の参照。生ログは持たない
}
```

### FindingState

```ts
export type FindingState =
  | "detected"      // 検知した（まだ言っていない）
  | "notified"      // 発言した
  | "acknowledged"  // 人間が受け取った
  | "resolved"      // 解決を見届けた
  | "suppressed";   // 抑制（重複・ノイズ）
```

## EquipmentScope — 装備の細分権限

装備内の細分権限（設計書 §9.1 の `scopes`）。最小権限で支給する。

```ts
export interface EquipmentScope {
  kind: string;               // "repo" | "database" | "channel" | ...
  value: string;              // 対象識別子（例 "edv4h/russell"）
  access: string;             // "read" | "write" | "issues" | "docs.pr" | ...
}
```

## ScopedPreApproval — スコープ付き事前承認

定常運転の外部書込みを毎回ボタン承認させないための限定承認（設計書 §12-2）。粒度は**操作種別 × 対象 × config_version × 件数上限 × 有効期限**。

```ts
export interface ScopedPreApproval {
  operation: string;          // 操作種別（例 "github.issues.create"）
  target: EquipmentScope;     // 対象（対象範囲）
  configVersion: string;      // この設定版に限定
  limit: { count: number; per: "day" | "week" | "month" };  // 件数上限
  expiresAt: string;          // 有効期限（ISO8601）
}
```

## Temperament — 気質パラメータ

人格と自発性の統合設定層（設計書 §6.1 の JSON を写像）。個体ごとに1つ持ち、人格プロンプト生成と気づき閾値の両方へ流れる。

```ts
export interface Temperament {
  name: string;               // 個体名（例 "覚", "詩織"）
  tone: string;               // 口調
  backstory: string;
  proactivity: number;        // 0–1。自発性
  daily_speak_cap: number;    // 自発発言の1日上限
  curiosity: number;          // 0–1
  reaction_rate: number;      // 0–1
}
```

## 通信面の型

### DeliveryResult

```ts
export interface DeliveryResult {
  status: "succeeded" | "failed" | "unknown";
  dedup?: boolean;            // idempotencyKey で二重送信を吸収
  detail?: string;
}
```

### ApprovalRequest / ApprovalOutcome

HITL。面が違っても契約は同じ（Slack は Block Kit ボタン、CLI は y/N）。

```ts
export interface ApprovalRequest {
  id: string;
  summary: string;            // 承認者に見せる要約
  operation: string;          // 対象操作（効果分類つき）
  effect: EffectClass;
  preview?: string;           // 実行内容のプレビュー（起票本文等）
  reasonRequired?: boolean;   // 却下時に理由入力を求める
}
export interface ApprovalOutcome {
  decision: "approved" | "rejected";
  by: string;                 // 承認者
  at: string;                 // ISO8601
  reason?: string;
}
```

### InboundMessage / OutboundMessage

surface が正規化して扱うメッセージ。**受信は既定で `trust_label: "untrusted"`**（設計書 §6.1 / §12-3）。

```ts
export interface InboundMessage {
  surface: string;            // "slack" | "cli" | "web"
  threadId: string;
  text: string;
  author: { id: string; isHuman: boolean };
  trust_label: "untrusted" | "trusted";  // 外部由来は untrusted 固定
  receivedAt: string;         // ISO8601
}

export interface OutboundMessage {
  surface: string;
  threadId: string;
  text: string;
  idempotencyKey: string;     // 二重送信防止。blind retry しない
  inReplyTo?: string;
}
```

## 関連

- 契約・レジストリ: [`30-russell-plugin-contract.md`](./30-russell-plugin-contract.md)
- コア API・ライフサイクル: [`31-core-api.md`](./31-core-api.md)
- 各ガイド: [`../guides/22-authoring-equipment.md`](../guides/22-authoring-equipment.md), [`../guides/23-authoring-a-finding.md`](../guides/23-authoring-a-finding.md)
