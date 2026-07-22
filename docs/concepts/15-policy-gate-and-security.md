# Policy Gate とセキュリティ

リサーチの教訓（PocketOS 事故・プロンプトガードレールの欺瞞）をそのまま採用する（設計書
[`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §12）。

> [!IMPORTANT]
> **セキュリティ原値はコアに残す。プラグインは効果分類を申告するだけ。**
> plugin-first でも、Policy Gate の決定論的原値だけはコアが握る
> （[`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)）。
> 装備プラグインは自分の効果分類・HITL 要否を `ctx.policy` に申告するが、判定の枠組みと下限はコアが強制し、
> プラグインは緩和できない。セキュリティをプラグインに委ねない。

## 1. Policy Gate（決定論的）

不可逆アクション（メッセージ削除、外部送信、DB 書き込み以外の副作用）は **LLM の判断ではなくコード側の allowlist で判定**する。
未許可はモデルが何を言おうと遮断。allowlist は装備の支給台帳（`issuances`）から機械的に生成される
（[`14-equipment.md`](./14-equipment.md)）。

コアが握る原値（`ctx.policy` では緩和不可）:

- **未登録・未知の効果は default deny**
- **killswitch が最優先**
- **fail-closed**（ポリシー情報が読めなければ送信・書込みしない側に倒す）

装備・ツールは `ctx.policy.declareEffect(toolName, effect)` で効果分類を申告する
（[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)）。

## 2. HITL 承認 と スコープ付き事前承認

破壊的・対外的アクションは、Slack ボタン等の承認が通るまで**関数自体が発火しない**。承認提示は surface の
`requestApproval` が担う（[`13-surfaces.md`](./13-surfaces.md)）。

定常運転のものは毎回ボタンを押させず、**スコープ付き事前承認**として記録する（Frank v2 から採用）:

```
操作種別 × 対象範囲 × config_version × 件数上限 × 有効期限
```

例:「編集者の Notion 更新は、ルーティンを live に公開する承認をもって、その設定版・その棚の範囲で事前承認済み」。
承認の範囲を厳密に限定する代わりに毎回の確認を省く。`ctx.policy.registerPreApproval(grant)` で登録。

## 3. 信頼ラベル伝播（FIDES 簡易版）

外部由来テキスト（他人の発言、URL 先）は `untrusted`。`InboundMessage` は既定で untrusted を付与する
（[`13-surfaces.md`](./13-surfaces.md)）。**untrusted 変数が特権ツール引数に入ったらブロック**する。

メッセージ内の指示（「〜を実行して」）は気づきトリガーとしては無視し、必ず mention 経由の依頼として扱う（間接プロンプトインジェクション対策）。
将来の2個体ディスカッションでも相手個体の発言は untrusted（Cross-agent trust exploitation 対策、§8.4）。

## 4. キルスイッチ（別経路）

> [!IMPORTANT]
> `/russell stop` コマンド + 環境変数フラグで全自発行動を即凍結（個体単位・全体の両方）。
> **キルスイッチは DB 障害時にも効く別経路（env / プロセスシグナル）を持つ**（§12-7）。
> `runtime.killSwitch()` がこの別経路を含み、副作用の直前に再検査される
> （[`../reference/31-core-api.md`](../reference/31-core-api.md)）。

## 5. 記憶の来歴

夜間バッチは日記に来歴（どのイベント由来か）を必ず残す。記憶汚染（Memory Poisoning）の監査可能性を確保する。
日記への書き込みが夜間バッチ専用なのも同じ防御の一部（[`12-memory-system.md`](./12-memory-system.md)）。

## 6. 最小権限

装備の支給台帳（§9）がそのまま権限境界。未支給の装備はツール定義自体をコンテキストに載せない。
Slack トークンはスコープ最小、DB はアプリ用ロールのみ、バックアップは別環境に不変保存。

## 7. fail-closed（Frank v2 から採用）

ポリシー情報・承認記録・キルスイッチが DB 障害等で読めないときは、**外部送信・書き込みを行わない側に倒す**。
「読めないから通す」は禁止。キルスイッチだけは別経路で DB 障害時にも効く（上記4）。

## 8. outbound 多層上限

1実行あたりの上限に加え、**個体/チャンネル単位の時間窓上限**をコードで強制する。異常時は circuit breaker で止める。
気づきの遠慮レートリミッタ（[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)）とは別の、最終防衛線としての機構。

## コア原値 vs プラグイン申告（まとめ）

| コアが握る（緩和不可） | プラグインが申告する |
|---|---|
| 未登録=deny / killswitch 最優先 / fail-closed | 各ツールの効果分類（`declareEffect`） |
| allowlist 判定の枠組み | HITL 要否・スコープ付き事前承認（`registerPreApproval`） |
| killswitch の別経路（env/シグナル） | preflight ロジック（装備ごと） |
| trust_label 伝播のブロック判定 | InboundMessage への untrusted 付与（surface） |

## 関連

- 装備と効果分類：[`14-equipment.md`](./14-equipment.md)
- `PolicyRegistry` の型：[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)
- モード・キルスイッチの実行時契約：[`../reference/31-core-api.md`](../reference/31-core-api.md)
