# インフラ・アカウント準備チェックリスト

> [!NOTE]
> 準備物 B-2。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §11（技術スタック）・§10（Slack）・§12（セキュリティ）が源泉。
> plugin-first（[`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）でも実行ホストは `apps/agent`（app + worker の2プロセス）1つ。インフラはこのホストを動かす前提で用意する。

## 全体像

| 項目 | 選定（設計書推奨） | 状態 |
|---|---|---|
| Claude API | 本番/開発でキー分離 | TODO 契約 |
| デプロイ先 | Cloud Run（min-instances=1）or Fly.io | TODO 決定 |
| DB | Postgres + pgvector | TODO 契約 |
| Slack アプリ | Socket Mode・最小スコープ | TODO 作成 |
| GitHub | russell 本体 + セルフイシュー起票先 | TODO 作成 |
| シークレット管理 | env or Secret Manager | TODO 決定 |

---

## 1. Claude API キー

- [ ] Anthropic の組織アカウントを用意（既存の社内アカウントを使うか新設か）
- [ ] **本番用と開発用でキーを分離**（開発の実験が本番の使用量台帳・コストを汚さない、§11 観測）
- [ ] rate limit（RPM / TPM）の現行ティアを確認。夜間バッチ（Slow Path, §4）+ 気づきスコアラー（Haiku, §6）+ 対話が同時に走ってもレート上限に当たらないか試算 → [`../operations/cost-budget.md`](../operations/cost-budget.md)
- [ ] モデルアクセス確認: 会話 Sonnet / フィルタ・夜間バルク Haiku / 石橋 Opus（§8.1・§11）が全部使えるティアか
- [ ] app プロセスと worker プロセスの API 並列度上限を分離できるよう、キーまたはクライアント設定を分ける（バッチが対話の予算を食い潰さない、§2）

> [!TODO] Anthropic アカウントの契約主体（既存社内組織 / 新規）と支払い方法の決定 — 承認者: プロダクトオーナー + 経理。月額上限は [`../operations/cost-budget.md`](../operations/cost-budget.md) と一致させる。

## 2. デプロイ先 + Postgres

設計書 §11: Socket Mode は常駐1コンテナで足りる。

- [ ] デプロイ先を Cloud Run（`min-instances=1`）か Fly.io から決定
  - Cloud Run: min-instances=1 で常駐維持（Socket Mode の WebSocket を切らさない）。GCP 既存資産があるなら有利
  - Fly.io: 常駐コンテナが素直。Postgres も同居させやすい
- [ ] Postgres を用意し **pgvector 拡張を有効化**（`CREATE EXTENSION vector;`）。記憶（VECTOR(1024)）・キュー（pg-boss）・監査（event_log）を1インスタンスに同居（§11）
- [ ] マネージド Postgres の選定（Cloud SQL / Fly Postgres / Neon / Supabase 等）。pgvector 対応と接続数、バックアップ機能を確認
- [ ] **バックアップは別環境に不変保存**（§12-6）。PITR かスナップショットの保持方針を決める
- [ ] マイグレーションは Alembic 等で expand→backfill→contract。**起動時 CREATE TABLE はしない**（§11）
- [ ] app / worker の2プロセス構成（§2）。worker は pg-boss で Postgres に同居、対話とバッチの並列度上限を分離

> [!TODO] デプロイ先（Cloud Run vs Fly.io）と Postgres プロバイダの決定 — 承認者: プロダクトオーナー + インフラ担当。判断軸: 既存クラウド資産、pgvector 対応、月額、常駐コスト。

## 3. Slack アプリ作成

設計書 §10 / plugin-first では `surface-slack`（[`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md) の slack 装備）。

- [ ] Slack アプリを作成し **Socket Mode を有効化**（サーバー inbound 開放不要, §10）
- [ ] Bot Token Scopes を**最小権限**で申請（§10・§12-6）:
  - `app_mentions:read` / `channels:history` / `im:history` / `chat:write` / `reactions:write`
  - それ以上は付けない。将来必要になったら都度追加申請
- [ ] Event Subscriptions: `app_mention` / `message.im` / `message.channels`（参加チャンネル分, §10）
- [ ] Interactivity 有効化（HITL 承認の Block Kit ボタン, §10・§12-2）
- [ ] **ワークスペース管理者の承認**を取得（アプリのインストール・スコープ承認は管理者権限）
- [ ] App-Level Token（Socket Mode 用, `connections:write`）と Bot Token を発行 → シークレット管理へ
- [ ] 個体ごとに Bot ユーザーを分けるか（`@bob` と `@詩織` を別アプリ/別 bot にするか）を決める

> [!TODO] Slack ワークスペース管理者の承認取得と、個体=bot の対応関係（1アプリ複数個体 or 個体ごとにアプリ）の決定 — 承認者: Slack ワークスペース管理者 + プロダクトオーナー。表示名・日報チャンネル名は [`../initial-data/temperament-unit-01.md`](../initial-data/temperament-unit-01.md) と揃える。

## 4. GitHub リポジトリ + CI

- [ ] **russell 本体リポジトリ**を作成（このプレップリポの後継 or 同一。pnpm + Turborepo モノレポ、[`../../reference/33-package-layout.md`](../../reference/33-package-layout.md)）
- [ ] **セルフイシュー起票先リポジトリ**を確定（§6.4。原則 russell 本体と同一。`github.issues` 装備は self-repo-only, [`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md)）
- [ ] Russell 用の GitHub トークン（Fine-grained PAT / GitHub App）を発行し、**対象リポを起票先に限定**（スコープをトークン側でも二重強制）
- [ ] CI 方針: typecheck / test / lint（biome）を PR で回す。**policy/ ・装備スコープ・プロンプトは人間レビュー必須**（外注任せにしない, A-3）
- [ ] 装備 conformance suite（A-2）を CI に組み込む枠を用意（全 MCP 装備共通テスト）
- [ ] シークレットを CI に置く場合は最小権限のデプロイ用トークンに限定

> [!TODO] russell 本体リポの置き場所（個人 org / 会社 org）とセルフイシュー起票先の確定、CI サービス（GitHub Actions 想定）の決定 — 承認者: リポジトリ管理者。公開/非公開の別も決める（セルフイシュー本文は公開リポでも安全な内容に限定, §6.4）。

## 5. シークレット管理

- [ ] 保管対象を洗い出す: Claude API キー（本番/開発）、Slack Bot/App Token、GitHub トークン、Postgres 接続情報、各 MCP サーバーの認証情報（[`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md)）
- [ ] env（`.env` + デプロイ先の環境変数）か Secret Manager（GCP Secret Manager / Fly secrets 等）かを決める
  - 最低ライン: リポジトリに平文で置かない、開発/本番で別値
  - 推奨: Secret Manager でローテーション可能に
- [ ] **キルスイッチの env 別経路を確保**（§12-4/§12-7）: DB 障害時にも効くよう、全体停止フラグは環境変数/プロセスシグナルで持つ（Secret Manager 依存にしない）→ [`../operations/kill-switch.md`](../operations/kill-switch.md)
- [ ] DB ロールは**アプリ用ロールのみ**最小権限で発行（§12-6）

> [!TODO] シークレット管理方式（env vs Secret Manager）の決定 — 承認者: インフラ担当 + セキュリティ。キルスイッチ env フラグだけは方式によらず必ず env/シグナル経路で持つ（fail-closed, §12-7）。

## 発注時の引き渡し物

外注に渡すのは「アカウント/キーそのもの」ではなく**接続の枠**（開発用キー・開発ワークスペース・開発 DB）。本番シークレットは発注側が保持し、live 昇格時に発注側が投入する（A-3 のレビュー体制と一貫）。

関連: [`../operations/cost-budget.md`](../operations/cost-budget.md) / [`../operations/kill-switch.md`](../operations/kill-switch.md) / [`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md) / [`../../reference/33-package-layout.md`](../../reference/33-package-layout.md)
