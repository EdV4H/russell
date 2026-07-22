> [!NOTE]
> 原本 `ryo-preparation-checklist.md`（PDF: `~/Downloads/ryo-preparation-checklist.md.pdf`）を復元したもの。
> 各項目の実務ドキュメントは [`../preparation/`](../preparation/) 以下に対応する。進捗は [`../../README.md`](../../README.md) のダッシュボードで追う。
>
> **【改称】** 本プロジェクトは **Ryo → Russell** に改称。本チェックリストは原本 PDF の忠実復元のため **Ryo 表記を残す**（用語対応は [`plugin-first-reinterpretation.md`](./plugin-first-reinterpretation.md)）。

# Ryo 実装着手前の準備物リスト

設計書（`human-like-agent-design.md`）を外注に渡す前に揃えるべきもの。**発注前ブロッカー → 発注時に渡すもの → 並行で進められるもの** の3段階に分類。

---

## A. 発注前ブロッカー（これがないと外注が動けない / 動かすべきでない）

### A-1. 社内合意：従業員データの記憶と公開 ★最重要

Ryoは同僚のSlack発言を記憶（本棚・日記）に貯め、しかも全公開する設計。技術以前に社内の合意が要る。

- [ ] 従業員のSlack発言を記憶・要約・日報公開することの労務・プライバシー観点の確認（人事・法務）
- [ ] 記憶のretention方針ドラフト（保持期間・削除依頼への対応手順。Frank v2も「Phase 1からPII複製が始まる前に定めよ」としている）
- [ ] 「忘れて」と言われたときの削除範囲の定義（本棚だけか、日記の記述も遡って消すか）
- [ ] 日記の機微情報ガードの線引きルール（設計書の残課題1。個人評価・健康・人事情報は書かない、等の具体リスト）
- [ ] 参加チャンネルのopt-in/opt-out方針（Ryoが読んでいいチャンネルの決め方）

→ [`../preparation/governance/privacy-and-memory-policy.md`](../preparation/governance/privacy-and-memory-policy.md), [`sensitive-info-guard.md`](../preparation/governance/sensitive-info-guard.md)

### A-2. 受け入れ基準書（test-strategy相当）

Frank v2が `docs/test-strategy.md` を別文書として持っているのと同じものがRyoにも要る。外注の納品判定はこれで行う。

- [ ] フェーズごとの機械判定可能な合格基準（P0: mention応答のレイテンシ/成功率、P1: 「昨日の件」想起テストの正答率、P3: dryrun Findingの精度=人間レビューでの妥当率）
- [ ] 装備conformance suite仕様（全MCP装備に流す共通テスト：権限エラー・timeout・OperationResult=unknownの扱い）
- [ ] dryrun→live昇格の判定手順（何日分・誰がレビュー・何%で合格）
- [ ] 「人間らしさ」評価の設計（残課題3。週次アンケート項目・記憶想起の抜き打ちテスト）

→ [`../preparation/acceptance/`](../preparation/acceptance/)

### A-3. スコープと契約の定義

- [ ] 発注スコープ書：P0〜P3を段階発注にするか一括か。各フェーズの完了定義（設計書§13の表を発注単位に変換）
- [ ] 設計書内の「実装者が決めてよいこと / 発注側承認が要ること」の仕分け（例：λの初期値は任せる、効果分類の追加はこちらの承認）
- [ ] コードレビュー体制：誰がPRを見るか（外注任せにしない箇所 = policy/・装備スコープ・プロンプト）

→ [`../preparation/governance/scope-and-contract.md`](../preparation/governance/scope-and-contract.md)

---

## B. 発注時に渡すもの（設計書の付属文書）

### B-1. 初期データ定義

- [ ] 個体1号のtemperament確定値（名前・口調・backstory・proactivity等。候補：覚 / スポンジプリセット）
- [ ] プリセット4種（スポンジ・編集者・番頭・石橋）の正式JSONスキーマとデフォルト値
- [ ] Finding kind / reason_code の初期辞書（deadline_risk, doc_drift, platform_bug, user_feedback… 各定義と例）
- [ ] 装備台帳の初期リスト（slack / github.issues / notion / terminal それぞれのMCPサーバー選定・スコープ・danger_level・効果分類）
- [ ] ビルトイン習慣3種のprompt本文ドラフト（朝の始業・夕方の振り返り・週次レビュー）
- [ ] 日記・読書カード・日報の生成プロンプトドラフト（機微情報ガード込み）

→ [`../preparation/initial-data/`](../preparation/initial-data/)

### B-2. インフラ・アカウント準備

- [ ] Claude APIキー（本番/開発の分離、rate limit確認）
- [ ] デプロイ先の契約（Cloud Run or Fly.io）+ Postgres（pgvector有効）
- [ ] Slackアプリの作成（Socket Mode・スコープ申請はこちらで実施。ワークスペース管理者の承認が必要）
- [ ] GitHubリポジトリ（ryo本体 + セルフイシュー起票先）・CI設定の方針
- [ ] シークレット管理の方法決定（環境変数でよいか、Secret Manager使うか）

→ [`../preparation/infra/setup-checklist.md`](../preparation/infra/setup-checklist.md)

---

## C. 並行で進められるもの

### C-1. ドッグフーディング設計

- [ ] 投入する実務チャンネルの選定と、そのチャンネルの住人への事前説明（「AIの同僚が入ります。読むもの・書くもの・記憶すること」）
- [ ] 日報チャンネル・管理チャンネル（dryrun出力先）の作成
- [ ] 成功指標の定義（週あたり有用Finding数、質問への回答正答率、アンケートの「同僚感」スコア、切りたくなったら切る基準も）
- [ ] フィードバック導線の周知（「うざかったら本人に言えばIssueになる」）

→ [`../preparation/dogfooding/plan.md`](../preparation/dogfooding/plan.md)

### C-2. 運用体制

- [ ] 承認者（オーナー）の決定：live公開承認・装備支給・temperament変更は誰の権限か
- [ ] キルスイッチの権限者と発動基準・連絡フロー（1枚もの）
- [ ] インシデント対応手順ドラフト（誤送信・記憶汚染・暴走時に誰が何をするか）
- [ ] コスト試算と月額上限：トークン予算/ターン × 想定ターン数 + 夜間バッチ + 気づきスコアラー → 月額。使用量台帳のアラート閾値

→ [`../preparation/operations/`](../preparation/operations/)

### C-3. 将来に向けた整理

- [ ] 設計書の英訳 or 図解版（外注先が海外・多国籍の場合）
- [ ] P4以降（ディスカッション機能・管理画面）のバックログ化

→ [`../preparation/backlog/future.md`](../preparation/backlog/future.md)

---

## 優先順位の提案

1. **A-1（社内合意）を最初に。** 技術は外注できるが、これは発注側にしかできない。しかも結論次第で設計が変わる（全公開→限定公開になる可能性）
2. **A-2（受け入れ基準）を発注交渉と同時に。** これがないと「完成しました」を判定できない
3. **B-1の初期データ定義は設計の続きとして楽しく作れる部分**（temperament・習慣プロンプト・Finding辞書）
