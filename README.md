# Ryo — 準備リポジトリ

**Ryo（僚）**は「一人の同僚がそこにいる」をコンセプトにした、人間らしい業務エージェント基盤。
人間らしさを性格の演技ではなく、**記憶の道具**（メモ帳・日記・本棚・書庫）と**生活リズム**（習慣・睡眠・忘却）という内部機構として実装する。

このリポジトリは実装着手前の **準備リポジトリ** で、コードはまだ含まない。設計書を外注に渡して実装を始める前に、発注側にしか用意できない準備物（社内合意・受け入れ基準・スコープ契約・初期データ・インフラ手配）を揃え、進捗を1画面で追う。

## アーキテクチャ方針：Plugin-First（極小コア + プラグイン）

> **Slack常駐はコアのコンセプトではない。Slack はコミュニケーションツールというプラグインの一つに過ぎない。**

コアはエージェント（認知ループ + 記憶 + 生活リズム + Policy Gate原値）だけを持ち、**通信面(surface)・装備(equipment)・記憶(memory)・気づき(finding)・習慣(routine)・モデル(model)はすべてプラグイン**として外に出す。手本は同一モノレポ親 `~/Projects/usketch` の PluginParty アーキテクチャ。npm 公開前提でパッケージは `@edv4h/ryo-*`。

詳細 → [`docs/design/plugin-first-reinterpretation.md`](docs/design/plugin-first-reinterpretation.md) / [`docs/concepts/10-plugin-architecture.md`](docs/concepts/10-plugin-architecture.md)

## ドキュメント

| セクション | 内容 |
|---|---|
| [docs/getting-started/](docs/getting-started/) | 概要・用語 |
| [docs/concepts/](docs/concepts/) | アーキテクチャの why / what（プラグイン基盤・記憶・装備・気づき・Policy Gate 等） |
| [docs/guides/](docs/guides/) | プラグイン／プリセットの作り方 |
| [docs/reference/](docs/reference/) | RyoPlugin契約・コアAPI・ドメイン型・パッケージ構成 |
| [docs/design/](docs/design/) | 原本設計書・準備物チェックリスト・plugin-first 再解釈 |
| [docs/preparation/](docs/preparation/) | 発注準備物（下記ダッシュボード） |

- 設計書（source of truth）: [`docs/design/human-like-agent-design.md`](docs/design/human-like-agent-design.md)
- 準備物チェックリスト: [`docs/design/preparation-checklist.md`](docs/design/preparation-checklist.md)

## 準備物 進捗ダッシュボード

状態: 🔴 未着手 / 🟡 作成中（ドラフト有・要決定TODO残） / 🔵 レビュー待ち / 🟢 確定

優先順位（提案）: **A-1 → A-2 → B-1**。A-1 は発注側にしかできず、結論次第で設計が変わる。

### A. 発注前ブロッカー

| # | 項目 | 状態 | 担当 | ドキュメント |
|---|---|---|---|---|
| A-1 | プライバシー・記憶保持方針（retention/削除範囲/opt-in） | 🟡 | `[!TODO]` 人事・法務 | [privacy-and-memory-policy](docs/preparation/governance/privacy-and-memory-policy.md) |
| A-1 | 日記/日報の機微情報ガード線引き | 🟡 | `[!TODO]` | [sensitive-info-guard](docs/preparation/governance/sensitive-info-guard.md) |
| A-2 | 受け入れ基準（フェーズ別 機械判定） | 🟡 | `[!TODO]` | [test-strategy](docs/preparation/acceptance/test-strategy.md) |
| A-2 | 装備/プラグイン conformance suite | 🟡 | `[!TODO]` | [equipment-conformance-suite](docs/preparation/acceptance/equipment-conformance-suite.md) |
| A-2 | dryrun→live 昇格判定手順 | 🟡 | `[!TODO]` | [dryrun-to-live-promotion](docs/preparation/acceptance/dryrun-to-live-promotion.md) |
| A-2 | 「人間らしさ」評価設計 | 🟡 | `[!TODO]` | [humanness-eval](docs/preparation/acceptance/humanness-eval.md) |
| A-3 | スコープと契約（段階発注/裁量仕分け/レビュー体制） | 🟡 | `[!TODO]` | [scope-and-contract](docs/preparation/governance/scope-and-contract.md) |

### B. 発注時に渡すもの

| # | 項目 | 状態 | 担当 | ドキュメント |
|---|---|---|---|---|
| B-1 | 個体1号 temperament 確定値 | 🟡 | `[!TODO]` 個体名 | [temperament-unit-01](docs/preparation/initial-data/temperament-unit-01.md) |
| B-1 | プリセット4種 JSONスキーマ+デフォルト | 🟡 | — | [presets](docs/preparation/initial-data/presets.md) |
| B-1 | Finding kind / reason_code 初期辞書 | 🟡 | — | [finding-dictionary](docs/preparation/initial-data/finding-dictionary.md) |
| B-1 | 装備台帳 初期リスト | 🟡 | `[!TODO]` MCP選定 | [equipment-ledger](docs/preparation/initial-data/equipment-ledger.md) |
| B-1 | ビルトイン習慣3種 プロンプト | 🟡 | — | [prompts/habits](docs/preparation/initial-data/prompts/habits.md) |
| B-1 | 日記・読書カード・日報 生成プロンプト | 🟡 | — | [prompts/journal-and-report](docs/preparation/initial-data/prompts/journal-and-report.md) |
| B-2 | インフラ・アカウント準備 | 🟡 | `[!TODO]` | [setup-checklist](docs/preparation/infra/setup-checklist.md) |

### C. 並行で進められるもの

| # | 項目 | 状態 | 担当 | ドキュメント |
|---|---|---|---|---|
| C-1 | ドッグフーディング設計 | 🟡 | `[!TODO]` チャンネル選定 | [dogfooding/plan](docs/preparation/dogfooding/plan.md) |
| C-2 | 承認者・権限の決定 | 🟡 | `[!TODO]` | [ownership-and-approval](docs/preparation/operations/ownership-and-approval.md) |
| C-2 | キルスイッチ（権限者・発動基準） | 🟡 | `[!TODO]` | [kill-switch](docs/preparation/operations/kill-switch.md) |
| C-2 | インシデント対応手順 | 🟡 | — | [incident-response](docs/preparation/operations/incident-response.md) |
| C-2 | コスト試算・月額上限 | 🟡 | `[!TODO]` 上限 | [cost-budget](docs/preparation/operations/cost-budget.md) |
| C-3 | 将来バックログ（P4/管理画面/英訳） | 🟡 | — | [backlog/future](docs/preparation/backlog/future.md) |

> 状態列は初期ドラフト投入時点の想定。各ドキュメント内の `> [!TODO]` を解消し、レビューを経て 🟢 に更新していく。
