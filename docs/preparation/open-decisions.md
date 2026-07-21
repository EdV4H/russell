# 未決事項レジスタ（Open Decisions）

各準備ドキュメントに散在する `> [!TODO]`（人間判断が必要な事項）を1か所に集約したもの。
準備の**順繰り作業リスト**として使う。優先順は [`../design/preparation-checklist.md`](../design/preparation-checklist.md) に従い **A-1 → A-2 → B-1 → B-2 → C**。

状態: ⬜ 未決 / 🔄 検討中 / ✅ 確定。埋まったら該当ドキュメント側の `[!TODO]` も解消し、[`../../README.md`](../../README.md) ダッシュボードを更新する。

> [!NOTE]
> このレジスタは各ドキュメントの TODO の索引。詳細・文脈・ドラフト値は各リンク先を参照。ここは「誰が何を決めるか」の一覧に徹する。

## A-1. 社内合意（★最初に。結論次第で設計が変わる）

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| A1-1 | 従業員Slack発言の記憶・要約・日報公開の労務/プライバシー可否 | 人事・法務 | ⬜ | [privacy-and-memory-policy](governance/privacy-and-memory-policy.md) |
| A1-2 | retention 方針（保持期間・削除依頼対応手順） | 人事・法務 | ⬜ | 〃 |
| A1-3 | 「忘れて」の削除範囲（本棚だけか / 日記も遡及消去か） | プライバシーオーナー | ⬜ | 〃 |
| A1-4 | 参加チャンネルの opt-in / opt-out 方針 | プライバシーオーナー | ⬜ | 〃 |
| A1-5 | 日記/日報の機微情報ガード具体 NG リスト（残課題1） | 人事・法務・PO | ⬜ | [sensitive-info-guard](governance/sensitive-info-guard.md) / [prompts/journal-and-report](initial-data/prompts/journal-and-report.md) |
| A1-6 | 機微ガードの検知漏れ率・過剰保留率の目標値 | PO・実装担当 | ⬜ | [sensitive-info-guard](governance/sensitive-info-guard.md) |

## A-2. 受け入れ基準

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| A2-1 | フェーズ別 機械判定基準の閾値（P0レイテンシ/成功率、P1想起正答率、P3 Finding妥当率 等） | PO・実装担当 | ⬜ | [test-strategy](acceptance/test-strategy.md) |
| A2-2 | 装備/プラグイン conformance suite の合格基準 | 実装担当 | ⬜ | [equipment-conformance-suite](acceptance/equipment-conformance-suite.md) |
| A2-3 | dryrun→live 昇格判定（日数・レビュアー・合格率） | レビュアー・PO | ⬜ | [dryrun-to-live-promotion](acceptance/dryrun-to-live-promotion.md) |
| A2-4 | 「人間らしさ」評価の実施頻度・担当（残課題2） | PO | ⬜ | [humanness-eval](acceptance/humanness-eval.md) |

## A-3. スコープと契約

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| A3-1 | 段階発注 vs 一括（プラグイン単位の発注切り分け） | PO | ⬜ | [scope-and-contract](governance/scope-and-contract.md) |
| A3-2 | 実装者裁量 / 発注側承認の仕分け最終確定 | PO | ⬜ | 〃 |
| A3-3 | コードレビュー体制（policy/・装備スコープ・プロンプトは誰が見るか） | PO | ⬜ | 〃 |

## B-1. 初期データ（設計の続きとして作れる部分。ドラフト済み）

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| B1-1 | 個体1号の名前（候補: 覚）・Slack表示名/ハンドル・日報チャンネル名 | PO | ⬜ | [temperament-unit-01](initial-data/temperament-unit-01.md) |
| B1-2 | 個体1号 backstory の最終サインオフ | PO・人事 | ⬜ | 〃 |
| B1-3 | 初期リリースは個体1号のみか / 複数同時か | PO | ⬜ | [presets](initial-data/presets.md) |
| B1-4 | platform_bug / user_feedback 自動起票の週あたり件数上限（例: 3件/週） | PO・リポ管理者 | ⬜ | [finding-dictionary](initial-data/finding-dictionary.md) |
| B1-5 | 追加 Finding kind（stale_thread / memory_conflict）を初期辞書に含めるか | PO | ⬜ | 〃 |
| B1-6 | slack MCP サーバー選定（自前 Bolt/Socket vs 既存 MCP）と surface/装備の責務分界 | 実装担当・リポ管理者 | ⬜ | [equipment-ledger](initial-data/equipment-ledger.md) |
| B1-7 | github.issues MCP 選定・起票先リポ・self-repo-only スコープ強制方法 | リポ管理者 | ⬜ | 〃 |
| B1-8 | notion MCP 選定・書き込み許可ワークスペース/ページ範囲 | PO・Notion管理者 | ⬜ | 〃 |
| B1-9 | terminal サンドボックス基盤選定（当面凍結） | PO・インフラ | ⬜ | 〃 |
| B1-10 | 個体1号にセルフイシュー装備を初期支給するか / P3まで凍結か | PO・リポ管理者 | ⬜ | 〃 |
| B1-11 | 習慣 cron 時刻・営業日/祝日カレンダーの持ち方 | PO | ⬜ | [prompts/habits](initial-data/prompts/habits.md) |
| B1-12 | 機微ガード後段フィルタの実装方針（正規表現 vs 軽量分類モデル） | 実装担当 | ⬜ | [prompts/journal-and-report](initial-data/prompts/journal-and-report.md) |

## B-2. インフラ・アカウント

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| B2-1 | Anthropic 契約主体（社内組織/新規）・支払い方法 | PO・経理 | ⬜ | [setup-checklist](infra/setup-checklist.md) |
| B2-2 | デプロイ先（Cloud Run vs Fly.io）・Postgres プロバイダ | PO・インフラ | ⬜ | 〃 |
| B2-3 | Slack ワークスペース管理者承認・個体=botの対応関係 | Slack管理者・PO | ⬜ | 〃 |
| B2-4 | ryo本体リポの置き場所（個人/会社org）・公開非公開・CIサービス | リポ管理者 | ⬜ | 〃 |
| B2-5 | シークレット管理方式（env vs Secret Manager） | インフラ・セキュリティ | ⬜ | 〃 |

## C-1. ドッグフーディング

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| C1-1 | 投入実務チャンネルの選定 | PO・チャンネルメンバー | ⬜ | [dogfooding/plan](dogfooding/plan.md) |
| C1-2 | 住人向け説明文の最終文面・担当者 | PO・人事 | ⬜ | 〃 |
| C1-3 | 週次アンケートの実施方法（Slack WF / Google Form）・タイミング | PO | ⬜ | 〃 |

## C-2. 運用体制

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| C2-1 | 承認者（オーナー）ロールの担当者名 | PO | ⬜ | [ownership-and-approval](operations/ownership-and-approval.md) |
| C2-2 | 承認の記録先（event_log ＋ #ryo-管理 ピン留め / Notion 台帳） | 実装担当 | ⬜ | 〃 |
| C2-3 | キルスイッチ権限者・オンコール担当・連絡先 | PO | ⬜ | [kill-switch](operations/kill-switch.md) |
| C2-4 | 凍結粒度（mention応答も止めるか）・env フラグ名・シグナル | 実装担当・PO | ⬜ | 〃 |
| C2-5 | インシデント各ロール担当者・就業時間外連絡フロー | PO | ⬜ | [incident-response](operations/incident-response.md) |
| C2-6 | 記憶汚染時の削除依頼対応と A-1「忘れて」範囲の一本化 | プライバシーオーナー | ⬜ | 〃 |
| C2-7 | 月額上限（個体あたり・全体）・100%到達時の挙動（自発off / 完全停止） | PO・経理 | ⬜ | [cost-budget](operations/cost-budget.md) |
| C2-8 | 使用量イベント台帳スキーマ（cost_usd 算出・単価テーブルの持ち方） | 実装担当 | ⬜ | 〃 |
| ✅ | モデル単価の確定 | 実装担当 | ✅ | [cost-budget](operations/cost-budget.md)（Haiku 4.5 $1/$5・Sonnet 5 $3/$15(導入$2/$10)・Opus 4.8 $5/$25 で確定） |

## C-3. 将来整理（バックログ）

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| C3-1 | ディスカッション機能の着手条件・ラリー上限初期値（残課題4） | PO | ⬜ | [backlog/future](backlog/future.md) |
| C3-2 | 管理画面の要否と範囲 | PO | ⬜ | 〃 |
| C3-3 | 外注先の言語・英訳/図解の要否 | PO | ⬜ | 〃 |
| C3-4 | ムードメーカー等 間接価値プリセットを入れるか（残課題3） | PO | ⬜ | 〃 |

---

_PO = プロダクトオーナー。担当ロールの実名は [ownership-and-approval](operations/ownership-and-approval.md) 確定後に紐付ける。_
