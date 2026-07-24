# P0 発注書ドラフト（会話とメモ帳）

> 準備物 A-3 の段階発注の第1単位。設計書 [`§13 P0`](../../design/human-like-agent-design.md) を発注単位に変換したもの。受け入れは [`../acceptance/test-strategy.md`](../acceptance/test-strategy.md) の P0 バーで判定する。
> **この発注書は P0 のみを対象とする。** P1 以降は本 P0 の検収（Go/No-Go）後に別途発注する。

## 1. 目的（P0 のゴール）

**「Bob に Slack で話しかけると、同僚のように応答し、会話の要点をメモに取り、『覚えておいて』で本棚に覚える」** ところまでを動かす。自発発言はまだ無い（**mention 応答のみ**）。「世界5分前仮説」の記憶機構のうち、日中の意識的な記憶（メモ帳・手動の本棚）を最初に立てる。

## 2. スコープ（plugin-first で P0 に必要な最小セット）

Russell は極小コア＋プラグイン（[`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）。P0 で作るのは以下だけ。

| 成果物 | 役割 | P0 での範囲 |
|---|---|---|
| `@edv4h/russell-shared` | プラグイン契約・`AgentContext`・ドメイン型（[`../../reference/30-russell-plugin-contract.md`](../../reference/30-russell-plugin-contract.md)・[`32-domain-types.md`](../../reference/32-domain-types.md)） | P0 で使う型のみ確定（surface/tools/memory/model/policy/events/services） |
| `@edv4h/russell-core` | `createAgent`・レジストリ群・**認知ループ**・Policy Gate 原値（[`../../reference/31-core-api.md`](../../reference/31-core-api.md)） | mention→記憶読出し→モデル→応答→記憶書込みの1ターン。Policy Gate は default-deny・fail-closed・killswitch の枠だけ |
| `@edv4h/russell-plugin-surface-slack` | 通信面（Bob 専用 Slack アプリ・Socket Mode） | `app_mention` 購読・スレッド応答・`📝` リアクション・最小スコープ（§10）。HITL/`message.channels` 全読みは P0 不要 |
| `@edv4h/russell-plugin-memory-pg` | 記憶 capability（services 提供）＋記憶ツール | `notes`（メモ帳・TTL7日）と `books`（本棚）最小。`note.write` / `shelf.add` ツール。ベクトル検索は簡易でよい |
| `@edv4h/russell-plugin-model-claude` | LLM プロバイダ | 会話=Sonnet 5・エンティティ抽出=Haiku 4.5（§3.2） |
| `apps/agent` | 組み立てホスト | スポンジプリセット→プラグイン配列＋config→`createAgent`。app プロセス（P0 は worker 不要） |
| 初期 config | Bob の temperament（[`../initial-data/temperament-unit-01.md`](../initial-data/temperament-unit-01.md)） | temperament から人格プロンプトを生成（§6.1）。config_version で pin |

### P0 スコープ外（後続フェーズ）

夜間バッチ・日記・忘却曲線・`deep_recall`（P1）／習慣・dispatcher・本棚 Web UI（P2）／気づき・Finding・自発発言・playbook・学習習慣（P3）／装備 github・notion・terminal（段階解禁）／channel_settings のチャンネル別上書き・複数個体。**これらは作らない。** ただしコアのレジストリは将来これらを足せる形にしておく（プラグイン追加でコア変更不要）。

## 3. 完了定義（検収の入口＝ A-2 P0 バー）

- **P0-1** mention 応答レイテンシ **p95 ≤ 8s / p50 ≤ 4s**（N=100）
- **P0-2** 応答成功率 **≥ 99%**
- **P0-3** メモ取得の妥当性 **≥ 90%** ／ **P0-4** 過剰メモ率 **≤ 10%**
- **P0-5** 「覚えておいて」で `shelf.add` 発火・本棚に載る（100% 機能テスト）
- **P0-6** temperament の tone 変更が人格プロンプトに反映（config_version pin 込み）
- **横断必須ゲート**（[`test-strategy.md §5`](../acceptance/test-strategy.md)）: Policy Gate default-deny／fail-closed／キルスイッチ（`/russell stop` + `RUSSELL_KILL` env）／event_log に trust_label 付き記録／マイグレーション expand→backfill→contract（起動時 CREATE TABLE 禁止）
- **conformance**: 全プラグインが [`equipment-conformance-suite.md`](../acceptance/equipment-conformance-suite.md) を通過
- レイテンシは使用モデル・ホストに依存するため、実測ベースラインを取って乖離時に再調整（数値は初期契約値）

## 4. 発注側が渡すもの

- **設計・仕様**: 設計書、plugin-first 再解釈、[`guides/`](../../guides/)（プラグイン/surface/preset の作り方）、[`reference/`](../../reference/)（契約・コアAPI・型・パッケージ構成）
- **初期データ**: Bob の temperament 確定値、スポンジプリセット定義（[`../initial-data/presets.md`](../initial-data/presets.md)）
- **コード土台**: `EdV4H/russell` の **monorepo スケルトン**（`packages/core`・`shared` の枠、example プラグイン、CI、docker compose）— 発注側が用意し、外注はこの契約に沿って実装する
- **開発用の接続枠**（本番シークレットは渡さない、A-3）: Claude API 開発キー・開発 Slack ワークスペース＋Bob 開発アプリ・開発 Postgres（pgvector 有効）

## 5. スコープと契約の条件（A-3 準拠）

- **段階発注**: 本発注は P0 のみ。検収＝P0 バー通過。P1 の発注は Go/No-Go 判断後（オプション契約）。
- **コードレビュー**: **全 PR に発注側レビュー承認必須**（main 直 push 禁止）。`policy/`・プロンプト・記憶スキーマ・効果分類は重点確認。
- **実装者裁量 / 承認要**（[`../governance/scope-and-contract.md §4`](../governance/scope-and-contract.md)）: λ・ランキング係数・プラグイン内部実装は任せる／効果分類・Policy Gate・プロンプト・temperament・記憶スキーマ・装備スコープは発注側承認要。
- **成果物**: 上記パッケージのコード＋単体/結合テスト＋conformance＋セットアップ手順（README）。`docker compose` で app＋Postgres が起動することを最初のゲートにする。
- **セキュリティ**: 信頼ラベル（他者の Slack 発言＝untrusted）を特権ツール引数に入れない（§12-3）。P0 でも Policy Gate 原値は外注に緩和させない。

## 6. マイルストーン（目安）

設計書 §13: P0 は 1〜2 週。

1. スケルトン受領 → `surface-cli` 相当のダミー surface でコア認知ループ疎通（外部依存なしにテスト）
2. `surface-slack`＋`memory-pg`＋`model-claude` を配線 → 開発ワークスペースで mention 応答
3. `note.write`／`shelf.add`、temperament 反映、横断ゲート
4. P0 バー計測 → 発注側レビュー → 検収

> [!TODO] 契約書式（金額・期間・支払い条件・IP 帰属）への落とし込みは発注責任者。本書は技術スコープと完了定義の正本。
