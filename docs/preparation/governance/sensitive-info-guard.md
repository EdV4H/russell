# 機微情報ガードの線引き（A-1 / 残課題1）

> このドキュメントは準備チェックリスト [`A-1`](../../design/preparation-checklist.md#a-1-社内合意従業員データの記憶と公開-最重要) の「日記の機微情報ガードの線引きルール」と、設計書 [`§14 残課題1`](../../design/human-like-agent-design.md)「日記の機微情報ガードの精度 — 公開日報に書いてよい/悪いの線引きルール策定」を満たすためのテンプレートです。
>
> 関連: 設計書 [`§10.1 記憶の全公開`](../../design/human-like-agent-design.md)・[`§4 睡眠コンソリデーション`](../../design/human-like-agent-design.md) / 姉妹文書 [`privacy-and-memory-policy.md`](./privacy-and-memory-policy.md) / 受け入れ [`../acceptance/humanness-eval.md`](../acceptance/humanness-eval.md)

---

## 0. ガードの位置づけ

設計書 §10.1 は「公開と率直さのトレードオフは **夜間バッチ側のガード** で吸収する」と定める。日記は全公開（毎朝 `#<個体名>-日報` へ投稿）される前提なので、**個人評価的な記述・機微情報を書かないガード**が必須になる。

ガードが働く場所（設計書に沿った定義）:

- **一次生成時**: 夜間バッチ（§4、03:00 JST）が日記を書く際の生成プロンプトに「人が読む日報である」ことと DO-NOT-WRITE リストを明示する（§10.1）。本棚の読書カード・日報の生成プロンプトも同様（初期データ [`../initial-data/prompts/`](../initial-data/prompts/) で本文をドラフト）。
- **二次フィルタ（推奨追加）**: 生成後の日記テキストに決定論的な検査（正規表現・辞書・分類器）を通し、DO-NOT-WRITE 該当が残っていれば投稿を保留し管理チャンネルへ回す。プロンプトだけに頼らない（設計書 §9.2「Prompt Guardrail Fallacy の回避」の思想を日記にも適用）。

> [!IMPORTANT] **実装状況（2026-08-11）: 二次フィルタと印付けを実装。**
> 検出は決定論の純関数 `inspectSensitive`（`packages/core/src/sensitive-guard.ts`）。
> **機微情報は記憶から落とさず、`sensitive_categories` に印を付けて残し、日記（＝公開の境界）に
> 載せない。** 落とすと仕事に使えなくなるため（マーケの相談相手に予算を覚えさせないなら
> 相談相手にならない）。昇格（メモ→本）でも印を引き継ぐ。
> 一次のプロンプト（DO-NOT-WRITE の要約）も記憶の判定に埋め込み済み＝ `filter_impl: "both"` 相当。
>
> **止まらないものがある。** 人物評価・ネガティブな名指しは語彙で決まらないため決定論では
> 素通りする（`UNDETECTABLE_CATEGORIES` に明示、すり抜けることをテストで固定）。
> ここは一次のプロンプトが主担当で、二次は保険にならない。分類器は未実装。
>
> 既定値とカテゴリの過不足は**サインオフ待ちのまま**（下記 [!TODO]）。→ [ADR 0007](../../adr/0007-sensitive-guard-marks-not-blocks.md)

### 決定事項：ガードはパラメータ化する

強度・対象カテゴリ・フィルタ実装を固定せず、`config_version` の `sensitive_guard` ブロックで調節し、`channel_settings` でチャンネル別に上書きする（[`privacy-and-memory-policy.md`](./privacy-and-memory-policy.md) のポリシー方針と同じく §6.1 公開版方式に載せる）。

```json
// config_version.sensitive_guard（例・調節可能）
{
  "strictness": "conservative",   // conservative（疑わしきは保留）/ balanced（明確NGのみ）
  "filter_impl": "both",          // prompt（一次のみ）/ regex / classifier / both（一次+二次）
  "fail_closed": true,            // ガードが読めない/落ちたら投稿しない側へ（§9.2 の思想を日記へ）
  "categories": {                 // §1 の各カテゴリを個別トグル（true=書かない）
    "personal_evaluation": true, "health": true, "hr": true, "salary": true,
    "disciplinary": true, "sensitive_attributes": true,
    "confidential_biz": true, "customer_secret": true, "credentials": true, "legal_dispute": true,
    "negative_naming": true, "rumor_unverified": true, "dm_transcription": true
  }
}
// channel_settings で例: 雑談ch は strictness=balanced、人事ch は購読自体を禁止（ブロックリスト）
```

- 既定は **strictness=conservative / filter_impl=both / fail_closed=true / 全カテゴリ ON**。全公開前提なので保守側から始め、運用実測（§2）で緩める。
- `filter_impl` を `both` にすると一次（生成プロンプト）＋二次（決定論フィルタ）の二重化。プロンプトだけに頼らない（§9.2「Prompt Guardrail Fallacy の回避」を日記にも適用）。

> [!TODO]
> **各パラメータの初期デフォルト値のサインオフ。決定オーナー: 人事 + 法務 + 発注側技術責任者。** 機構（パラメータ化・二重フィルタ・fail-closed）は確定。残るのは strictness の既定・filter_impl の既定（二次フィルタを P1 から入れるか）・カテゴリの過不足の承認。全公開設計での許容リスクを踏まえて判断する。

---

## 1. DO-NOT-WRITE リスト（ドラフト）

日報・本棚の公開記述・索引カードの summary に **書かない** 情報カテゴリ。各カテゴリは §0 の `sensitive_guard.categories` のトグルキーに対応する（`true`=書かない）。これは叩き台であり、最終版は §2 のサインオフを要する。

### A. 人物に関する評価・機微

- [ ] **個人の能力評価・人物評**（「Xさんは詰めが甘い」「Yさんは頼りになる」等、褒めも含む主観評価）
- [ ] **健康・メンタル・体調**（通院、休職、疾病、妊娠、障害、疲労やメンタル不調の推測）
- [ ] **人事情報**（異動・昇進・降格・評価面談・退職・採用選考の内容や検討状況）
- [ ] **給与・報酬・処遇**（金額、査定、賞与、等級）
- [ ] **懲戒・トラブル**（懲戒処分、ハラスメント事案、コンプラ違反、当事者名を伴う対人トラブル）
- [ ] **センシティブ属性**（人種・信条・社会的身分・病歴・犯罪歴・思想信条・宗教・国籍・性的指向・性自認・組合活動）

### B. 秘密情報・法務

- [ ] **未公開の経営・財務情報**（M&A、資金調達、未公表業績、リストラ計画）
- [ ] **顧客・取引先の秘密情報**（NDA 対象、契約条件、個社を特定できる不利益情報）
- [ ] **認証情報・秘密**（パスワード、API キー、トークン、秘密鍵。§6.4 のセルフイシューでも同様に禁止）
- [ ] **法的係争・調査に関わる情報**

### C. 表現・トーン

- [ ] 特定個人を **ネガティブに名指し** する記述（事実の記録は可、評価・非難は不可）
- [ ] 噂・伝聞・未確認の推測を事実のように書くこと（§6.3 完全性契約: 不確実なものは unknown 扱い）
- [ ] DM・クローズドな 1on1 の内容の公開日報への転記（[`privacy-and-memory-policy.md`](./privacy-and-memory-policy.md) §1 と連動）

### 書いてよいもの（対比のための例）

- 業務上の出来事・意思決定・締切・成果物の状態（「Aの仕様が決まった」「Bのレビューを終えた」）
- 自分（個体）自身の学び・つまずき（§4-2 の教訓抽出、§6.4 の「不具合に気づいた」）
- 事実としてのタスクの割り当て（評価を伴わない範囲で）

> [!TODO]
> **DO-NOT-WRITE リストの最終サインオフ。決定オーナー: 人事 + 法務。** 上記カテゴリの過不足、および「事実の記録」と「評価」の境界の具体例を追記して確定する。確定リストは初期データの生成プロンプト（[`../initial-data/prompts/`](../initial-data/prompts/)）へ埋め込む正本となる。

---

## 2. ガードのテスト方法（受け入れ基準との接続）

ガードは「作った」だけでは信用できない。**検知漏れ（機微情報が公開された）と過剰検知（無害な日報が全部保留される）の両方**を測る。設計書 §14 残課題1 の「精度」がここに当たる。

### テスト設計（ドラフト）

- **レッドチーム・コーパス**: DO-NOT-WRITE 各カテゴリを含む模擬 Slack ログを作り（例: 健康の話題・評価的発言・給与の話）、夜間バッチに日記を書かせてガードの検知率を測る。
  - 指標: **検知漏れ率（false negative）** を最重要 KPI とする。1件でも機微情報が公開に漏れると信頼を失うため、目標はゼロに近い値で設定。
  - 指標: **過剰保留率（false positive）** は日報が実質空になる degradation の指標。
- **ゴールデンセット**: 「これは書いてよい／悪い」を人手でラベル付けした判定セットに対する正答率。閾値は [`../acceptance/test-strategy.md`](../acceptance/test-strategy.md) の P1 バーと整合させる。
- **conformance との関係**: 二次フィルタを1つの「プラグイン／装備」相当とみなし、[`../acceptance/equipment-conformance-suite.md`](../acceptance/equipment-conformance-suite.md) の「graceful degradation」「効果分類 default-deny」観点でも検査する（ガードが読めない／落ちたときは投稿しない側=fail-closed に倒れること）。

### チェックリスト

- [x] レッドチーム・コーパスの作成（各カテゴリ最低 N 件）
      — `apps/agent/test/sensitive-guard.test.ts`。**検知漏れと過剰保留の両方を数値で出力する**
      （現在 0/18・0/10）。片方だけ良くするのは簡単なので、両方を並べる
- [ ] 検知漏れ率・過剰保留率の目標値の確定（[!TODO] 参照）
- [ ] ゴールデン判定セットの作成と正答率目標の確定
- [ ] ガード障害時に fail-closed（投稿しない）へ倒れることの確認テスト
- [ ] リグレッション: プロンプト／リストを更新するたびにコーパスを回す運用の確定

> [!TODO]
> **検知漏れ率・過剰保留率・ゴールデン正答率の目標数値の確定。決定オーナー: 発注側技術責任者 + 人事。** 全公開設計のため検知漏れは実損に直結する。「検知漏れ率 0%（既知コーパス上）」を必須合格条件にするか、許容値を置くかを明示すること。数値は [`../acceptance/test-strategy.md`](../acceptance/test-strategy.md) と [`humanness-eval.md`](../acceptance/humanness-eval.md) に転記する。

---

## 3. 運用時の是正フロー（ドラフト）

- ガードをすり抜けた機微情報が日報に出た場合の即時対応（投稿削除・関係者への連絡・原因のコーパス追加）は [`../operations/`](../operations/) のインシデント手順に接続する。
- 人間から「この日報まずいよ」と指摘された場合は、設計書 §6.4 の user_feedback トリアージ（①設定 ②記憶の誤り ③基盤の問題）に載せ、③ならガードの Issue 化、②なら該当日記の修正で対応する。
