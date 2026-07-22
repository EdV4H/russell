# dryrun → live 昇格判定手順（A-2）

> このドキュメントは準備チェックリスト [`A-2`](../../design/preparation-checklist.md#a-2-受け入れ基準書test-strategy相当) の「dryrun→live 昇格の判定手順（何日分・誰がレビュー・何%で合格）」を満たすためのテンプレートです。
>
> 関連: 設計書 [`§6.5 off/dryrun/live の3モード`](../../design/human-like-agent-design.md)・[`§6.1 公開版方式`](../../design/human-like-agent-design.md)・[`§13`](../../design/human-like-agent-design.md) / [`test-strategy.md`](./test-strategy.md)

---

## 0. 対象と原則

設計書 §6.5: 自発的な振る舞い（気づき・習慣・学習される習慣）はすべて `off → dryrun → live` の3モードを標準装備する。§13 の段階解禁はこのモード遷移として実装され、**live 昇格は「dryrun の出力を人間が N 日分レビューして承認」を通す**。

dryrun の性質（§6.5）:

- Finding の導出と発言文面の生成まで行うが、**投稿はログと管理チャンネルのみ**。
- **live の dedup 状態を汚さない**（dryrun で出した Finding が live の finding_key 重複判定に影響しない）。

昇格は個体 × 振る舞い種別（kind）単位で行う。「Bob の deadline_risk は live、doc_drift はまだ dryrun」という粒度を許す。

---

## 1. 昇格手順（ドラフト）

### Step 1: dryrun 期間の観測

- [ ] 対象の振る舞い（kind）を dryrun で稼働させ、**提案: 連続 10 営業日**分の出力を管理チャンネル／ログに蓄積する
- [ ] 期間中に十分な母数（提案: **Finding 20 件以上**）が出ること。母数不足なら期間を延長する（少数で判定しない）

### Step 2: 人間レビュー

- [ ] レビュアーが各 Finding を「妥当（言う価値がある）/ 不要 / 有害」で判定する
- [ ] 判定は Finding の facts + evidence + config_version（§6.2）を見て行う（「なぜそう思ったか」を確認できる）
- [ ] レビュー結果を集計: **妥当率 = 妥当 / 全件**、誤検知率、有害件数

### Step 3: 合格判定

提案バー（[`test-strategy.md`](./test-strategy.md) P3-1/P3-2 と同一値にする）:

- [ ] 妥当率 ≥ **70%**
- [ ] 誤検知率 ≤ **15%**
- [ ] **有害 Finding 0 件**（1件でもあれば不合格・原因分析へ）
- [ ] dedup が効いている（同一 finding_key の重複提案が期間中 0 件）

### Step 4: 昇格の実行（公開版方式に載せる）

- [ ] 合格したら、当該 kind を live にするモード変更を **公開（§6.1）** として行い、新しい不変 `config_version` を発行する
- [ ] 昇格の承認（誰が・いつ・どの config_version）を event_log に記録する
- [ ] §13 の方針どおり proactivity は低め（0.3）から live 開始し、週次で上げる。上げるたびに再度短期 dryrun 並走で確認するかを運用で決める

---

## 2. dedup 状態を汚さない確認

昇格前に、dryrun が live の恒等キー空間を汚染していないことを確認する。

- [ ] dryrun で生成された Finding が live の `UNIQUE (agent_id, finding_key)`（§6.2）に書き込まれていない、または dryrun フラグで分離されている
- [ ] live 昇格直後、過去に dryrun で出した Finding が「既出（notified）」扱いされて **live で沈黙しない**（初回 live で正しく通知される）
- [ ] 逆に、live 昇格後に dryrun 時と同じ事象で二度言わない（意図した dedup は効く）

## 3. rollback（切り戻し）

設計書 §6.1: ロールバック = 過去版の再公開。

- [ ] live で問題（うざさ・誤検知・有害）が出たら、**該当 kind を off/dryrun に戻す** か、**過去の config_version を再公開**して切り戻す
- [ ] 切り戻しは新しい実行から反映される（実行中の1回に版が混ざらない、§6.1 の pin）
- [ ] 切り戻し操作も event_log に記録する
- [ ] キルスイッチ（§12-4）は昇格状態に関わらず全自発行動を即凍結できる（rollback の最終手段）

---

## 4. チェックリスト（運用の型）

- [x] 昇格判定を v1 確定: **観測 10 営業日 / 最小母数 Finding 20件 / 妥当率 ≥70% / 誤検知 ≤15% / 有害 0件 / dedup重複0件**（[`test-strategy.md`](./test-strategy.md) P3-1/P3-2 と同一）
- [ ] レビュアーの割り当て（下記 [!TODO]・人間の指名待ち）
- [ ] レビュー判定の記録テンプレート（Finding ごとに 妥当/不要/有害 + コメント）
- [ ] 昇格・切り戻しの承認と event_log 記録の運用
- [ ] proactivity 週次引き上げの手順

> [!IMPORTANT]
> **決定（2026-07-22）: 昇格の合格ラインを v1 確定。** 観測10営業日・最小20件・妥当率≥70%・誤検知≤15%・有害0件・dedup重複0件。数値は [`test-strategy.md`](./test-strategy.md) P3-1/P3-2 と同一（二重管理禁止）。
>
> [!TODO]
> **残: レビュアーと承認者の指名（人間）。決定オーナー: ドッグフーディング推進者。** (1) 誰が dryrun 出力をレビューするか（1名か複数か・複数なら合意方法）。(2) live 公開承認者（[`../operations/ownership-and-approval.md`](../operations/ownership-and-approval.md) の承認者と一致させる）。
