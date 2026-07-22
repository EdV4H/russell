# 未決事項レジスタ（Open Decisions）

各準備ドキュメントに散在する `> [!TODO]`（人間判断が必要な事項）を1か所に集約したもの。
準備の**順繰り作業リスト**として使う。優先順は [`../design/preparation-checklist.md`](../design/preparation-checklist.md) に従い **A-1 → A-2 → B-1 → B-2 → C**。

状態: ⬜ 未決 / 🔄 検討中 / ✅ 確定。埋まったら該当ドキュメント側の `[!TODO]` も解消し、[`../../README.md`](../../README.md) ダッシュボードを更新する。

> [!NOTE]
> このレジスタは各ドキュメントの TODO の索引。詳細・文脈・ドラフト値は各リンク先を参照。ここは「誰が何を決めるか」の一覧に徹する。

## A-1. 社内合意（★最初に。結論次第で設計が変わる）

> **本ラウンドの決定（2026-07-22）:** プライバシー方針（retention・「忘れて」削除範囲・機微ガード）は**固定せずパラメータ化**する（`config_version` で版管理・`channel_settings` で上書き、§6.1 公開版方式）。**機構は確定**し、各パラメータの**推奨デフォルト値をドラフト済み**。残るのは「デフォルト値と全公開前提そのものへの 人事・法務 サインオフ」。opt-in は既定として**確定**。

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| A1-1 | 全公開前提そのものの労務/プライバシー可否（＋方針全体の最終承認者） | 人事・法務 | ⬜ | [privacy-and-memory-policy](governance/privacy-and-memory-policy.md) |
| A1-2 | retention をパラメータ化（機構✅）＋デフォルト値（journal保持/書庫物理削除/退職者/SLA）のサインオフ | 法務・運用オーナー | 🔄 | 〃 §2 |
| A1-3 | 「忘れて」を段階(L1/L2/L3)＋mode パラメータ化（機構✅、既定L2/delete）＋既定のサインオフ | 法務・運用オーナー | 🔄 | 〃 §3 |
| A1-4 | 参加チャンネルは **opt-in 既定**（機構＋方針 確定） | プライバシーオーナー | ✅ | 〃 §4 |
| A1-5 | 機微ガードをパラメータ化（strictness/filter_impl/categories/channel上書き、機構✅）＋デフォルト＆NGリストのサインオフ | 人事・法務・PO | 🔄 | [sensitive-info-guard](governance/sensitive-info-guard.md) / [prompts/journal-and-report](initial-data/prompts/journal-and-report.md) |
| A1-6 | 機微ガードの検知漏れ率・過剰保留率・ゴールデン正答率の目標値 | PO・実装担当 | ⬜ | [sensitive-info-guard](governance/sensitive-info-guard.md) |

## A-2. 受け入れ基準

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
> **本ラウンドの決定（2026-07-22）:** 各フェーズの合格バーを **v1 採用値として確定**。残るのは (a) 実測依存値（latency）の再調整、(b) A1-6 連動（機微ガード検知漏れ目標）、(c) **レビュアー／実施担当の指名（人間）**のみ。

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| A2-1 | フェーズ別 機械判定バー v1確定（P0 p95≤8s/成功率≥99%、P1想起≥85%、P3妥当率≥70% 等）＋latency実測再調整 | PO・実装担当 | 🔵 | [test-strategy](acceptance/test-strategy.md) |
| A2-2 | 装備/プラグイン conformance suite を共通必須ゲートに採用（v1確定）＋terminal補遺/CI化は実装時 | 実装担当 | 🔵 | [equipment-conformance-suite](acceptance/equipment-conformance-suite.md) |
| A2-3 | dryrun→live 昇格判定 数値確定（10営業日/20件/妥当率≥70%/誤検知≤15%/有害0）＋レビュアー指名待ち | レビュアー・PO | 🔵 | [dryrun-to-live-promotion](acceptance/dryrun-to-live-promotion.md) |
| A2-4 | 「人間らしさ」評価 cadence/閾値確定（週1・5〜10問、同僚感≥3.5、うざさ≤2.0）＋実施担当指名待ち（残課題2） | PO | 🔵 | [humanness-eval](acceptance/humanness-eval.md) |

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
| B2-4 | russell本体リポの置き場所（個人/会社org）・公開非公開・CIサービス | リポ管理者 | ⬜ | 〃 |
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
| C2-2 | 承認の記録先（event_log ＋ #russell-管理 ピン留め / Notion 台帳） | 実装担当 | ⬜ | 〃 |
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
