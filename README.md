# Russell — 準備リポジトリ

**Russell** は「**世界5分前仮説**」に着想を得た、人間らしい業務エージェント基盤。
ラッセルの思考実験〈世界は5分前に、記憶や記録ごと丸ごと出現したかもしれない〉になぞらえ、**記憶を「所与のDB」ではなく「起動時に構成される道具」として扱う**。人間らしさを性格の演技ではなく、**記憶の道具**（メモ帳・日記・本棚・書庫）と**生活リズム**（習慣・睡眠・忘却）という内部機構として実装する。

> 旧称 **Ryo（僚）** から改称。中心メタファーを「同僚」から「世界5分前仮説」へ張り替えたもので、設計内容そのものは同じ。パッケージは `@edv4h/russell-*`。原本設計書（PDF復元）は忠実性のため Ryo 表記を残す（[用語対応](docs/getting-started/01-introduction.md)）。

このリポジトリは実装着手前の **準備リポジトリ** で、コードはまだ含まない。設計書を外注に渡して実装を始める前に、発注側にしか用意できない準備物（社内合意・受け入れ基準・スコープ契約・初期データ・インフラ手配）を揃え、進捗を1画面で追う。

## アーキテクチャ方針：Plugin-First（極小コア + プラグイン）

> **Slack常駐はコアのコンセプトではない。Slack はコミュニケーションツールというプラグインの一つに過ぎない。**

コアはエージェント（認知ループ + 記憶 + 生活リズム + Policy Gate原値）だけを持ち、**通信面(surface)・装備(equipment)・記憶(memory)・気づき(finding)・習慣(routine)・モデル(model)はすべてプラグイン**として外に出す。手本は同一モノレポ親 `~/Projects/usketch` の PluginParty アーキテクチャ。npm 公開前提でパッケージは `@edv4h/russell-*`。

詳細 → [`docs/design/plugin-first-reinterpretation.md`](docs/design/plugin-first-reinterpretation.md) / [`docs/concepts/10-plugin-architecture.md`](docs/concepts/10-plugin-architecture.md)

## ドキュメント

| セクション | 内容 |
|---|---|
| [docs/getting-started/](docs/getting-started/) | 概要・用語 |
| [docs/concepts/](docs/concepts/) | アーキテクチャの why / what（プラグイン基盤・記憶・装備・気づき・Policy Gate 等） |
| [docs/guides/](docs/guides/) | プラグイン／プリセットの作り方 |
| [docs/reference/](docs/reference/) | RussellPlugin契約・コアAPI・ドメイン型・パッケージ構成 |
| [docs/design/](docs/design/) | 原本設計書・準備物チェックリスト・plugin-first 再解釈 |
| [docs/preparation/](docs/preparation/) | 発注準備物（下記ダッシュボード） |

- 設計書（source of truth）: [`docs/design/human-like-agent-design.md`](docs/design/human-like-agent-design.md)
- 準備物チェックリスト: [`docs/design/preparation-checklist.md`](docs/design/preparation-checklist.md)

## 準備物 進捗ダッシュボード

状態: 🔴 未着手 / 🟡 作成中（ドラフト有・要決定TODO残） / 🔵 レビュー待ち / 🟢 確定

優先順位（提案）: **A-1 → A-2 → B-1**。A-1 は発注側にしかできず、結論次第で設計が変わる。
人間判断が必要な未決事項は [**未決事項レジスタ**](docs/preparation/open-decisions.md) に集約（順繰りの作業リスト）。
段階発注の第1単位は [**P0 発注書ドラフト**](docs/preparation/procurement/p0-order.md)（会話とメモ帳）。

### A. 発注前ブロッカー

| # | 項目 | 状態 | 担当 | ドキュメント |
|---|---|---|---|---|
| A-1 | プライバシー・記憶保持方針（retention/削除範囲/opt-in）**パラメータ化＝機構確定**・opt-in確定 | 🔵 | 人事・法務（デフォルト値サインオフ） | [privacy-and-memory-policy](docs/preparation/governance/privacy-and-memory-policy.md) |
| A-1 | 日記/日報の機微情報ガード**パラメータ化＝機構確定** | 🔵 | 人事・法務（デフォルト＆NGリスト承認） | [sensitive-info-guard](docs/preparation/governance/sensitive-info-guard.md) |
| A-2 | 受け入れ基準（フェーズ別 機械判定）**v1バー確定** | 🔵 | latency実測再調整のみ | [test-strategy](docs/preparation/acceptance/test-strategy.md) |
| A-2 | 装備/プラグイン conformance suite **共通ゲート採用** | 🔵 | terminal補遺/CI化は実装時 | [equipment-conformance-suite](docs/preparation/acceptance/equipment-conformance-suite.md) |
| A-2 | dryrun→live 昇格判定手順 **数値確定** | 🔵 | レビュアー指名待ち | [dryrun-to-live-promotion](docs/preparation/acceptance/dryrun-to-live-promotion.md) |
| A-2 | 「人間らしさ」評価設計 **cadence/閾値確定** | 🔵 | 実施担当指名待ち | [humanness-eval](docs/preparation/acceptance/humanness-eval.md) |
| A-3 | スコープと契約 **段階発注＋全PR発注側レビュー確定・裁量仕分けv1** | 🔵 | 承認者/レビュアー指名・plugin外注割当 | [scope-and-contract](docs/preparation/governance/scope-and-contract.md) |

### B. 発注時に渡すもの

| # | 項目 | 状態 | 担当 | ドキュメント |
|---|---|---|---|---|
| B-1 | 個体1号 temperament（**名前=Bob 確定**） | 🔵 | backstoryサインオフ | [temperament-unit-01](docs/preparation/initial-data/temperament-unit-01.md) |
| B-1 | プリセット4種 JSONスキーマ+デフォルト（**初期はBob1体**） | 🔵 | — | [presets](docs/preparation/initial-data/presets.md) |
| B-1 | Finding辞書＋**自動起票3件/週・追加kindP3送り確定** | 🔵 | — | [finding-dictionary](docs/preparation/initial-data/finding-dictionary.md) |
| B-1 | 装備台帳＋**MCP推奨確定・terminal凍結・セルフイシューP3** | 🔵 | 実装時にMCP最終確認 | [equipment-ledger](docs/preparation/initial-data/equipment-ledger.md) |
| B-1 | 習慣プロンプト＋**cron確定（9/18/金17 JST）** | 🔵 | — | [prompts/habits](docs/preparation/initial-data/prompts/habits.md) |
| B-1 | 日記・日報プロンプト（ガードはA1-5パラメータ） | 🔵 | NG語彙サインオフ | [prompts/journal-and-report](docs/preparation/initial-data/prompts/journal-and-report.md) |
| B-2 | インフラ **方針確定**（非依存コンテナ/個体別Slackアプリ/Secret Manager/リポ✅） | 🔵 | Anthropic契約主体・ホスト調達・Slack管理者承認 | [setup-checklist](docs/preparation/infra/setup-checklist.md) |

### C. 並行で進められるもの

| # | 項目 | 状態 | 担当 | ドキュメント |
|---|---|---|---|---|
| C-1 | ドッグフーディング設計（説明文/アンケート確定） | 🔵 | **投入チャンネル選定**（住人同意） | [dogfooding/plan](docs/preparation/dogfooding/plan.md) |
| C-2 | 承認 RACI＋ロスター（**氏名の集約先**） | 🔵 | 氏名記入待ち | [ownership-and-approval](docs/preparation/operations/ownership-and-approval.md) |
| C-2 | キルスイッチ **手順・粒度・envフラグ確定** | 🔵 | 権限者氏名（ロスター） | [kill-switch](docs/preparation/operations/kill-switch.md) |
| C-2 | インシデント対応手順 | 🔵 | 担当者はロスター | [incident-response](docs/preparation/operations/incident-response.md) |
| C-2 | コスト **上限挙動確定**（80/100/150%） | 🔵 | 金額サインオフ（経理） | [cost-budget](docs/preparation/operations/cost-budget.md) |
| C-3 | 将来バックログ（**方針確定**: 2体後ディスカッション/管理画面不要/国内前提/追加プリセットは実証後） | 🔵 | — | [backlog/future](docs/preparation/backlog/future.md) |

> 状態列は初期ドラフト投入時点の想定。各ドキュメント内の `> [!TODO]` を解消し、レビューを経て 🟢 に更新していく。
