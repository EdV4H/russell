# はじめに — Ryo とは

Ryo（僚）は「**一人の同僚がそこにいる**」をコンセプトにした、人間らしい業務エージェント基盤。
人間らしさを性格の演技ではなく、**記憶の道具**（メモ帳・日記・本棚・書庫）と**生活リズム**（習慣・睡眠・忘却）という内部機構として実装する。

Ryo は「素体」であり、**プリセット**（スポンジ／編集者／番頭／石橋）を適用して多様な同僚個体（例：覚、詩織）を派生させる。挙動の違いは演技ではなく認知アーキテクチャのパラメータ差から生まれる。

このリポジトリの詳細な設計思想は [`../design/human-like-agent-design.md`](../design/human-like-agent-design.md)（source of truth）を参照。

## このリポジトリの目的

実装着手前の**準備リポジトリ**である。設計書を外注に渡して実装を始める前に、発注側にしか用意できない準備物（社内合意・受け入れ基準・スコープ契約・初期データ・インフラ手配）を揃える。今はコードを含まない（アーキテクチャは docs 上の仕様として記述する）。

- 準備物の全体像とチェックリスト：[`../design/preparation-checklist.md`](../design/preparation-checklist.md)
- 進捗ダッシュボード：[`../../README.md`](../../README.md)

## 前提：Plugin-First アーキテクチャ

> [!IMPORTANT]
> **Slack常駐はコアのコンセプトではない。Slack はコミュニケーションツールというプラグインの一つに過ぎない。**

Ryo は **極小コア＋プラグイン**で構成する。コアはエージェント（認知ループ＋記憶＋生活リズム＋Policy Gate原値）だけを持ち、通信面（surface）・装備（equipment）・記憶（memory）・気づき（finding）・習慣（routine）・モデル（model）はすべてプラグインとして外に出す。手本は同一モノレポ親 `~/Projects/usketch` の PluginParty アーキテクチャ。

なぜこうするかは [`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)、仕組みは [`../concepts/10-plugin-architecture.md`](../concepts/10-plugin-architecture.md) を参照。

## ドキュメントの歩き方

| セクション | 内容 |
|---|---|
| [getting-started/](./) | 概要・用語（このセクション） |
| [concepts/](../concepts/) | アーキテクチャの why / what |
| [guides/](../guides/) | プラグインやプリセットの作り方（how-to） |
| [reference/](../reference/) | プラグイン契約・コアAPI・型・パッケージ構成の仕様 |
| [design/](../design/) | 原本設計書・準備物チェックリスト・plugin-first 再解釈 |
| [preparation/](../preparation/) | 発注準備物（A: 発注前ブロッカー / B: 発注時に渡す / C: 並行） |

新しく参加した人は `01-introduction` → `02-glossary` → `concepts/10-plugin-architecture` の順で読むとよい。
