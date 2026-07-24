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
| A3-1 | 発注形態＝**段階発注（P0→P3順）** 確定。各フェーズ A-2 バー通過を検収入口、Go/No-Go 判断者のみ指名待ち | PO | ✅ | [scope-and-contract](governance/scope-and-contract.md) §1 |
| A3-2 | 実装者裁量／発注側承認の仕分け表を **v1 採用**。残: 各承認要行の承認者割当（人間） | PO・技術責任者 | 🔵 | 〃 §4 |
| A3-3 | コードレビュー体制＝**全 PR 発注側レビュー** 確定（重点パスは重め）。残: レビュアー氏名・SLA | 技術責任者 | ✅ | 〃 §5 |
| A3-4 | plugin単位の内製／外注割当（memory-pg/finding/policy を外注に含めるか） | PO・技術責任者 | ⬜ | 〃 §2 |

## B-1. 初期データ（設計の続きとして作れる部分。ドラフト済み）

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| B1-1 | 個体1号 = **Bob**（スポンジボブ由来）確定。表示名 Bob / `@bob` / `#bob-日報`。残: backstoryサインオフ・Slackハンドル可否確認 | PO | ✅ | [temperament-unit-01](initial-data/temperament-unit-01.md) |
| B1-2 | 個体1号 backstory の最終サインオフ（ドラフト確定・確認のみ） | PO・人事 | ⬜ | 〃 |
| B1-3 | 初期リリース = **Bob 1体から**（他プリセットは P3 以降）確定 | PO | ✅ | [presets](initial-data/presets.md) |
| B1-4 | 自動起票 件数上限 = **3件/週**（パラメータ化）確定 | PO・リポ管理者 | ✅ | [finding-dictionary](initial-data/finding-dictionary.md) |
| B1-5 | 追加 Finding kind は **初期に含めず P3 以降**に確定 | PO | ✅ | 〃 |
| B1-6 | slack = **自前 Bolt/Socket 内蔵（推奨確定）**・受信=surface/送信=装備の責務分界確定。実装時に最終確認 | 実装担当 | 🔵 | [equipment-ledger](initial-data/equipment-ledger.md) |
| B1-7 | github.issues = **GitHub公式MCP・起票先 EdV4H/russell 限定・トークン二重強制（推奨確定）**。実装時に最終確認 | リポ管理者 | 🔵 | 〃 |
| B1-8 | notion = **公式MCP・read先行/write P3・指定ページ限定（推奨確定）**。範囲は編集者投入時に確定 | PO・Notion管理者 | 🔵 | 〃 |
| B1-9 | terminal = **当面凍結**（誰にも初期支給しない）確定 | PO・インフラ | ✅ | 〃 |
| B1-10 | Bob は P0〜P2 slack のみ・セルフイシューは **P3 で dryrun 経て支給** 確定 | PO・リポ管理者 | ✅ | 〃 |
| B1-11 | 習慣 cron = **9:00/18:00/金17:00 JST・祝日は初期手動カレンダー** 確定 | PO | ✅ | [prompts/habits](initial-data/prompts/habits.md) |
| B1-12 | 機微ガード後段フィルタ = A1-5 `filter_impl=both` 確定。regex/分類器の別は dryrun 実測で | 実装担当 | 🔵 | [prompts/journal-and-report](initial-data/prompts/journal-and-report.md) |

## B-2. インフラ・アカウント

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| B2-1 | Anthropic 契約主体・支払い方法（推奨: 社内組織アカウント＋本番/開発キー分離） | PO・経理 | ⬜ | [setup-checklist](infra/setup-checklist.md) |
| B2-2 | デプロイ = **プラットフォーム非依存コンテナ**（Cloud Run/Fly.io/任意で動く）確定。具体ホスト調達のみ残 | インフラ | 🔵 | 〃 |
| B2-3 | Slack = **個体ごとに別アプリ/別bot** 確定（Bob専用）。残: 管理者承認取得 | Slack管理者・PO | 🔵 | 〃 |
| B2-4 | リポ = **EdV4H/russell（作成済・private）**・起票先同一・CI=Actions 確定 | リポ管理者 | ✅ | 〃 |
| B2-5 | secrets = **デプロイ先Secret Manager＋RUSSELL_KILLはenv** 確定 | インフラ・セキュリティ | ✅ | 〃 |

## C-1. ドッグフーディング

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| C1-1 | 投入実務チャンネルの選定（唯一の真の残・住人同意が要る） | PO・チャンネルメンバー | ⬜ | [dogfooding/plan](dogfooding/plan.md) |
| C1-2 | 住人向け説明文 = 文面確定（Bob反映）。残: 人事の表現レビュー・告知担当（ロスター） | PO・人事 | 🔵 | 〃 |
| C1-3 | 週次アンケート = **Slack ワークフロー・金曜夕方** 確定 | PO | ✅ | 〃 |

## C-2. 運用体制

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
> **本ラウンドの決定（2026-07-23）:** 運用の**機構・ポリシーを確定**。RACI とキルスイッチ手順・コスト上限挙動を固め、**全ロールの氏名は [ownership-and-approval](operations/ownership-and-approval.md) の「担当者ロスター」1か所に集約**（A-2/A-3 の指名待ちもここへ）。残るのは氏名記入と金額サインオフ。

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| C2-1 | 承認 RACI 確定＋担当者ロスター整備。残: **氏名記入**（A-2/A-3 の指名もここで一括） | PO | 🔵 | [ownership-and-approval](operations/ownership-and-approval.md) |
| C2-2 | 承認の記録先 = **event_log ＋ #russell-管理 ピン留め**（Notionは任意）確定 | 実装担当 | ✅ | 〃 |
| C2-3 | キルスイッチ発動基準・経路・連絡フロー確定。権限者氏名はロスターへ集約 | PO | 🔵 | [kill-switch](operations/kill-switch.md) |
| C2-4 | 凍結粒度＋envフラグ確定（L1/2=自発off・mention継続、L3 `RUSSELL_KILL`=完全沈黙）。残: 別経路の起動テスト（実装時） | 実装担当・PO | ✅ | 〃 |
| C2-5 | インシデント手順ドラフト済。担当者はロスターへ集約 | PO | 🔵 | [incident-response](operations/incident-response.md) |
| C2-6 | 記憶汚染の削除対応を A1-3 の段階削除（L1/L2/L3＋mode）に一本化 | プライバシーオーナー | 🔵 | 〃 |
| C2-7 | 上限到達時の挙動確定（80%警告/100%自発off・mention継続/150%全停止検討、閾値パラメータ化）。残: **金額サインオフ** | PO・経理 | 🔵 | [cost-budget](operations/cost-budget.md) |
| C2-8 | 使用量イベント台帳スキーマ（cost_usd 算出・単価テーブルの持ち方） | 実装担当 | ⬜ | 〃（実装時） |
| — | モデル単価の確定 | 実装担当 | ✅ | [cost-budget](operations/cost-budget.md)（Haiku 4.5 $1/$5・Sonnet 5 $3/$15(導入$2/$10)・Opus 4.8 $5/$25） |

## C-3. 将来整理（バックログ）

| # | 決めること | 承認者 | 状態 | ドキュメント |
|---|---|---|---|---|
| C3-1 | ディスカッション機能 = **2体live安定後に着手・6往復・Slackスレッド**（方針確定） | PO | 🔵 | [backlog/future](backlog/future.md) |
| C3-2 | 管理画面 = **当面作らない**（Slack + 読み取りUIで運用）方針確定 | PO | 🔵 | 〃 |
| C3-3 | 英訳/図解 = **国内発注前提で当面不要**（海外発注時のみ）方針確定 | PO | 🔵 | 〃 |
| C3-4 | 追加プリセット = **初期4種実証後に検討**（残課題3）方針確定 | PO | 🔵 | 〃 |

---

_PO = プロダクトオーナー。担当ロールの実名は [ownership-and-approval](operations/ownership-and-approval.md) 確定後に紐付ける。_
