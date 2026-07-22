# ガイド: 気づき種別（finding）プラグインを書く

finding は「気づき」を一級のデータにする（設計書 §6.2）。スコアが閾値を超えたら喋る、という揮発的イベントではなく、**事実 + 根拠 + 提案アクションを持つ永続レコード**を出す検知器を書く。これにより個体は「気づいたけどまだ言っていない」「言ったが流された」「解決を見届けた」という状態を本当に持てる。

共通スケルトンは [`20-authoring-a-plugin.md`](./20-authoring-a-plugin.md) を先に。本ガイドは `FindingKindDefinition` に絞る。

> [!NOTE] 提案仕様
> コードは docs-only 段階の提案。型は実装時に `@edv4h/russell-shared` で確定する。

## FindingKindDefinition

finding プラグインは `ctx.findings.register(def)` で1つの `kind` の検知器を登録する。

```ts
export interface FindingKindDefinition {
  kind: string;                          // "deadline_risk" | "platform_bug" | ...
  // finding_key を決定的に生成（dedup・新旧比較の恒等キー）
  findingKey(input: DetectInput): string;
  // 検知本体。complete なソースだけを根拠に Finding を導出する
  detect(input: DetectInput): Promise<Finding[]>;
}
```

`Finding` / `FindingState` / `SourceResult` は [`../reference/32-domain-types.md`](../reference/32-domain-types.md) を参照。

## finding_key は決定的に

`finding_key` は dedup と新旧比較の**恒等キー**。同じ気づきが二度出ても同じキーになるよう、`kind + 主体 + 理由` から決定的に生成する（設計書 §6.2）。

```ts
// 例: deadline_risk — 主体はタスク、理由は「締切超過リスク」
findingKey(input) {
  return `deadline_risk:${input.taskId}:overdue_risk`;
}
```

`platform_bug` は主体が定まらないので、**エラーシグネチャのハッシュ**（例外種別 + 発生箇所）から生成する（設計書 §6.4）。これで同じ不具合が複数 Issue を立てない:

```ts
findingKey(input) {
  const sig = `${input.errorType}@${input.location}`;
  return `platform_bug:${sha256(sig).slice(0, 16)}`;
}
```

## facts と evidence

Finding には導出の根拠を必ず持たせる。後から「なぜそう思ったの?」に答えられるようにするため。

- **facts** — 導出に使った事実（**値 + 取得元 + 取得時刻**）。
- **evidence** — 根拠へのソース参照（Slack permalink など）。生ログや PII は入れず参照に留める。

```ts
{
  finding_key: "deadline_risk:T-123:overdue_risk",
  kind: "deadline_risk",
  reason_code: "due_in_24h_no_progress",
  facts: [
    { key: "due_at", value: "2026-07-22T18:00Z", source: "notion:task/T-123", observed_at: "2026-07-21T09:00Z" },
    { key: "last_update", value: "2026-07-18", source: "notion:task/T-123", observed_at: "2026-07-21T09:00Z" },
  ],
  evidence: [{ ref: "slack://permalink/…" }],
  proposed_action: "担当者に進捗を確認する",
  config_version: ctx.runtime.configVersion,
}
```

## 完全性契約 — complete のときだけ出す

**Finding を導出してよいのは、根拠にした全ソースが `SourceResult.status = "complete"` のときだけ**（設計書 §6.3）。partial / failed / unauthorized なソースに依存する気づきは `unknown` に落とすか、導出しない。

```ts
async detect(input) {
  const src = await fetchTasks();
  if (src.status !== "complete") {
    // 「動きなし」と言ってはいけない。見えていないことを知っている
    return [];
  }
  // complete なソースだけを根拠に導出
  return deriveFindings(src.data, input);
}
```

「データの不在も情報」だが、それを言えるのは全量が見えているときだけだ。取得失敗を「異常なし」と報告する同僚は信頼を失う。

## dedup と状態遷移

- 同じ `finding_key` の Finding が既に存在すれば**新規挿入しない**（`UNIQUE(agent_id, finding_key)`）。再発時の扱いは kind ごとに決める（platform_bug なら既存 Issue へコメント追記）。
- 状態は `detected → notified → acknowledged → resolved`、または `suppressed`。

```ts
export type FindingState =
  | "detected"      // 検知した（まだ言っていない）
  | "notified"      // 発言した
  | "acknowledged"  // 人間が受け取った
  | "resolved"      // 解決を見届けた
  | "suppressed";   // 抑制（重複・ノイズ）
```

発言はFinding と分離した配送レコード（NotificationPlan / DeliveryAttempt）で管理し、transactional outbox 経由で送る。送信の失敗・再試行を気づき自体の状態と混同しない（設計書 §6.2）。

## off / dryrun / live の3モード

自発的振る舞いは3モードを標準装備する（設計書 §6.5）。finding プラグインは `ctx.runtime.mode()` を副作用の直前に再検査する:

- **off** — 検知もしない。
- **dryrun** — Finding の**導出と発言文面の生成までは行う**が、投稿はログと管理チャンネルのみ。**live の dedup 状態を汚さない**（別テーブル or フラグで隔離）。
- **live** — 実際に発言・起票する。

live 昇格は「dryrun の出力を人間が N 日分レビューして承認」を通す。段階解禁（§13）はこのモード遷移として実装される。

## 例で見る2実装

### finding-deadline-risk

`@edv4h/russell-plugin-finding-deadline-risk`。締切が近いのに進捗がないタスクを検知する。

- `finding_key = deadline_risk:{taskId}:overdue_risk`。
- タスクソース（Notion 等）が `complete` のときだけ導出。partial なら沈黙。
- `proposed_action`: 担当者への進捗確認。番頭プリセットの自発性と噛み合う。

### finding-platform-bug（セルフイシュー）

`@edv4h/russell-plugin-finding-platform-bug`。個体が**自分の実行基盤**の不具合を検知して GitHub Issue に起票する（設計書 §6.4）。

- 検知ソースは**内部テレメトリのみ**: ExecutionRun の degraded/failed の繰り返し、装備の `OperationResult=unknown/rejected` の頻発、Policy Gate の想定外ブロック。**untrusted 由来テキスト（Slack 発言）を根拠にした自動起票は禁止**。
- `finding_key` はエラーシグネチャのハッシュ。再発時は新規起票せず既存 Issue にコメント追記（「また起きました。今回の run: …」）。
- 起票能力は `equipment-github`（`external_write`, 3件/週の事前承認）が提供。finding は「何を・いつ」を、装備は「どう起票するか」を担う → [`22-authoring-equipment.md`](./22-authoring-equipment.md#例-equipment-githubセルフイシュー)。
- Issue 本文は Finding の facts/evidence から生成（症状 / run id・config_version 参照 / 頻度 / 影響 / 可能なら修正案）。会話の生ログや PII は書かない。

## チェックリスト

- [ ] `ctx.findings.register` で自己分類
- [ ] `finding_key` を `kind + 主体 + 理由` から決定的に生成（platform_bug はエラーシグネチャのハッシュ）
- [ ] `SourceResult.status === "complete"` のときだけ導出
- [ ] facts に「値 + 取得元 + 取得時刻」、evidence は参照のみ（PII を書かない）
- [ ] `config_version` を記録（再現性）
- [ ] off/dryrun/live を `ctx.runtime.mode()` で副作用直前に再検査、dryrun は live の dedup を汚さない
