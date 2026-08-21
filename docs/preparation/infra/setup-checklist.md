# インフラ・アカウント準備チェックリスト

> [!NOTE]
> 準備物 B-2。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §11（技術スタック）・§10（Slack）・§12（セキュリティ）が源泉。
> plugin-first（[`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）でも実行ホストは `apps/agent`（app + worker の2プロセス）1つ。インフラはこのホストを動かす前提で用意する。

## 全体像

| 項目 | 選定 | 状態 |
|---|---|---|
| Claude API | 本番/開発でキー分離 | 🟡 契約主体（経理） |
| デプロイ先 | **プラットフォーム非依存コンテナ**（Cloud Run / Fly.io / 任意のコンテナ基盤で動く） | 🔵 方針確定 |
| DB | Postgres + pgvector（マネージドなら何でも可） | 🔵 方針確定 |
| Slack アプリ | **個体ごとに別アプリ/別 bot**・Socket Mode・最小スコープ | 🔵 方針確定（作成は調達時） |
| GitHub | **EdV4H/russell（作成済・private）** + セルフイシュー起票先=同一 | ✅ |
| シークレット管理 | **デプロイ先 Secret Manager ＋ RUSSELL_KILL は env** | 🔵 方針確定 |

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

> [!IMPORTANT] **決定（2026-07-24）: どこにでもデプロイできる「プラットフォーム非依存」設計にする。** 特定 PaaS にロックせず、次を前提にすれば Cloud Run / Fly.io / Render / 素の VM / k8s いずれでも動く:
> - **単一の Docker コンテナ**（app）＋ worker（同一イメージ・別プロセス or 別コンテナ）。ホスト固有 API に依存しない（12-factor）。
> - **設定はすべて env**（下の §5）。プラットフォーム固有の設定ファイルは薄い adapter に隔離。
> - **状態は Postgres(pgvector) だけ**。マネージドなら Cloud SQL / Fly Postgres / Neon / Supabase いずれでも可（pgvector 対応が唯一の必須要件）。
> - 常駐要件は「Socket Mode の WebSocket を切らさない1インスタンス」だけ（min-instances=1 相当）。
> こうすることで、契約先クラウドが後から変わっても移設できる（plugin-first と同じく「差し替え可能」を設計原則にする）。

- [x] デプロイ = プラットフォーム非依存コンテナ（上記）に確定。具体ホストは調達時に選ぶ（どれでも動く）
- [ ] Postgres を用意し **pgvector 拡張を有効化**（`CREATE EXTENSION vector;`）。記憶（VECTOR(1024)）・キュー（pg-boss）・監査（event_log）を1インスタンスに同居（§11）
- [ ] **バックアップは別環境に不変保存**（§12-6）。PITR かスナップショットの保持方針を決める
- [x] マイグレーションは `pnpm migrate` で expand→backfill→contract。**起動時 CREATE TABLE はしない**（§11） — [`../../reference/34-migrations.md`](../../reference/34-migrations.md)
- [ ] DB ロール分離: アプリ用ロールに DDL 権限を与えない（`DROP TABLE` はトリガで塞げない, §12-6）
- [ ] app / worker の2プロセス構成（§2）。worker は pg-boss で Postgres に同居、対話とバッチの並列度上限を分離
- [ ] 移設性の検証: ローカル（docker compose）で app+worker+Postgres が上がることを最初の CI ゲートにする

> [!TODO] 残: 実際のホスト先とマネージド Postgres プロバイダの調達（どれでも動く前提なので、既存クラウド資産・月額で選ぶだけ）— 承認者: インフラ担当。

## 3. Slack アプリ作成

設計書 §10 / plugin-first では `surface-slack`（[`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md) の slack 装備）。

- [ ] Slack アプリを作成する。**[`slack-app-manifest.yaml`](./slack-app-manifest.yaml) を "From a manifest" に貼る**のが確実
      （スコープ・イベント・Messages Tab・スラッシュコマンドが揃った状態で作られる。手で足すと必ずどれか漏れる）
- [ ] Socket Mode が有効になっていること（サーバー inbound 開放不要, §10）
- [ ] Bot Token Scopes を**最小権限**で申請（§10・§12-6）:
  - `app_mentions:read` / `channels:history` / `im:history` / `chat:write` / `reactions:write` / `commands`（`/russell` キルスイッチ用, §12-4）
  - `channels:read` / `groups:read` / `im:read` — **積み残しの確認**（返信し忘れの拾い直し）用。
    「どのチャンネルに入っているか」を数えるだけの権限。無くても通常の受信・返信は動く
  - スレッド追従を使うなら `groups:history` も（プライベートチャンネル用）。スコープを足したら**再インストールが必要**
  - それ以上は付けない。将来必要になったら都度追加申請
- [ ] Event Subscriptions: `app_mention` / `message.im`。スレッド追従を使うなら `message.channels` / `message.groups` も（**拾うのは参加スレッドの続きだけ**。allowlist は `RUSSELL_SLACK_CHANNELS`, [`../../concepts/13-surfaces.md`](../../concepts/13-surfaces.md)）
- [ ] **Slash Command `/russell` を登録**（キルスイッチ, §12-4）。Socket Mode なので Request URL は不要。`commands` スコープが要る → [`../../reference/35-killswitch.md`](../../reference/35-killswitch.md)
- [ ] Interactivity 有効化（HITL 承認の Block Kit ボタン, §10・§12-2）
- [ ] **ワークスペース管理者の承認**を取得（アプリのインストール・スコープ承認は管理者権限）
- [ ] App-Level Token（Socket Mode 用, `connections:write`）と Bot Token を発行 → シークレット管理へ
> [!IMPORTANT] **決定（2026-07-24）: 個体ごとに別 Slack アプリ/別 bot。** Bob は Bob 専用アプリ（表示名 `Bob`・`@bob`・`#bob-日報`）。将来の個体は各自の Slack アプリを持つ。個体の独立性・トークン分離を優先（管理コストは個体数に比例するが、当面 Bob のみ）。`surface-slack` プラグインは「1個体＝1アプリのトークン束」を config で受け取る。

- [x] 個体=アプリの対応を確定（個体ごとに別アプリ/別 bot）
- [ ] Bob 用 Slack アプリを1つ作成（上記スコープ・Socket Mode）

> [!TODO] 残: Slack ワークスペース管理者の承認取得（アプリインストール・スコープ承認）— 承認者: Slack ワークスペース管理者 + プロダクトオーナー。表示名・日報チャンネル名は [`../initial-data/temperament-unit-01.md`](../initial-data/temperament-unit-01.md)（Bob）と揃える。

## 4. GitHub リポジトリ + CI

- [ ] **russell 本体リポジトリ**を作成（このプレップリポの後継 or 同一。pnpm + Turborepo モノレポ、[`../../reference/33-package-layout.md`](../../reference/33-package-layout.md)）
- [ ] **セルフイシュー起票先リポジトリ**を確定（§6.4。原則 russell 本体と同一。`github.issues` 装備は self-repo-only, [`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md)）
- [ ] Russell 用の GitHub トークン（Fine-grained PAT / GitHub App）を発行し、**対象リポを起票先に限定**（スコープをトークン側でも二重強制）
- [ ] CI 方針: typecheck / test / lint（biome）を PR で回す。**policy/ ・装備スコープ・プロンプトは人間レビュー必須**（外注任せにしない, A-3）
- [ ] 装備 conformance suite（A-2）を CI に組み込む枠を用意（全 MCP 装備共通テスト）
- [ ] シークレットを CI に置く場合は最小権限のデプロイ用トークンに限定

> [!IMPORTANT] **決定（2026-07-24）: リポ = `EdV4H/russell`（作成済・private・個人アカウント）。** セルフイシュー起票先も同一リポ。CI = GitHub Actions。現状は準備リポ（docs のみ）だが、実装フェーズで同一リポに monorepo（[`../../reference/33-package-layout.md`](../../reference/33-package-layout.md)）を足す。
>
> [!TODO] 残（実装フェーズ）: 会社 org へ移すか個人のままかは発注形態確定時に再判断（[`../governance/scope-and-contract.md`](../governance/scope-and-contract.md)）。private 前提だが、セルフイシュー本文は将来 public 化しても安全な内容に限定する（§6.4）。

## 5. シークレット管理

- [ ] 保管対象を洗い出す: Claude API キー（本番/開発）、Slack Bot/App Token、GitHub トークン、Postgres 接続情報、各 MCP サーバーの認証情報（[`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md)）
- [ ] env（`.env` + デプロイ先の環境変数）か Secret Manager（GCP Secret Manager / Fly secrets 等）かを決める
  - 最低ライン: リポジトリに平文で置かない、開発/本番で別値
  - 推奨: Secret Manager でローテーション可能に
- [x] **キルスイッチの env 別経路を確保**（§12-4/§12-7）: DB 障害時にも効くよう、全体停止フラグは環境変数で持つ（Secret Manager 依存にしない）→ [`../operations/kill-switch.md`](../operations/kill-switch.md) / 実装は [`../../reference/35-killswitch.md`](../../reference/35-killswitch.md)。`RUSSELL_KILL=1` は DB を読まずに完全沈黙する（シグナル経路は未実装）
- [ ] **`RUSSELL_KILL_OPERATORS` に解除権限者の Slack user id を設定**（§12-4）: 未設定だと `/russell start`（解除）が誰にも実行できない。権限者は [`../operations/ownership-and-approval.md`](../operations/ownership-and-approval.md) の担当者ロスターと一致させる
- [ ] `RUSSELL_ADMIN_CHANNEL` に #russell-管理 のチャンネル ID を設定（キルスイッチ発動・解除の自動記録先）
- [ ] （任意）`RUSSELL_ALERT_CHANNEL` に、安全側に倒れたことを流す先を設定（#25）。
      **管理チャンネルと分けてある**——発動記録は「人がやった1回」だが、通知は**壊れている間ずっと出る**。
      未設定ならプロセスログにだけ出る
- [ ] Slack アプリの **Interactivity & Shortcuts** を ON にする（承認ボタン, #113）。
      Socket Mode が有効なら Request URL は不要。**スコープは増えないので入れ直しは不要**。
      off のままだとボタンは出るが押しても何も起きない（無反応という形で出る）
- [ ] （任意）`NOTION_PARENT_PAGE_ID` に、場所を指定されなかったときの作成先を設定。
      **制限ではなく既定**——書ける範囲は Notion 側の共有設定が決める。
      どこへ書くかは承認画面に名前で出る（#113）
- [ ] （任意）Google を読ませるなら、GCP プロジェクト `russell-bob-atrae` の
      **Internal** な OAuth クライアント（デスクトップ アプリ）を作り、
      `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を設定。そのうえで
      `pnpm --filter @edv4h/russell-worker google-auth` を**その個体のアカウントで**同意し、
      出てきた `GOOGLE_REFRESH_TOKEN` を設定する。
      **クライアントは全個体で共有、リフレッシュトークンは個体ごと**（身元はアカウント側にある）
- [ ] DB ロールは**アプリ用ロールのみ**最小権限で発行（§12-6）

> [!IMPORTANT] **決定（2026-07-24）: デプロイ先の Secret Manager で保管（GCP Secret Manager / Fly secrets 等・ローテーション可）、`RUSSELL_KILL` だけは方式によらず env/シグナル経路で別持ち（fail-closed, §12-7）。** リポに平文を置かない・開発/本番で別値。プラットフォーム非依存のため「Secret Manager から起動時に env へ注入」する薄い adapter にし、どのホストでも同じ読み出し口にする。DB ロールはアプリ用のみ最小権限（§12-6）。

## 発注時の引き渡し物

外注に渡すのは「アカウント/キーそのもの」ではなく**接続の枠**（開発用キー・開発ワークスペース・開発 DB）。本番シークレットは発注側が保持し、live 昇格時に発注側が投入する（A-3 のレビュー体制と一貫）。

関連: [`../operations/cost-budget.md`](../operations/cost-budget.md) / [`../operations/kill-switch.md`](../operations/kill-switch.md) / [`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md) / [`../../reference/33-package-layout.md`](../../reference/33-package-layout.md)
