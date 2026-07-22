# 用語集

Russell（旧称 Ryo）の設計に頻出する語。中心メタファーは「世界5分前仮説」（記憶を起動時に構成される道具として扱う）。メタファー（人間らしさの設計指針）と技術用語が混在するので対応づけて示す。

## コアの概念

| 用語 | 意味 |
|---|---|
| **素体 (Russell)** | ベースアーキテクチャ。プリセットを適用して個体を派生させる元 |
| **個体 (agent)** | 素体 + プリセット + temperament を持つ稼働単位。人間らしい名前を持つ（Bob、詩織） |
| **プリセット (preset)** | 認知アーキテクチャのパラメータ束 + 育ち方 + 装備 の3点セット。plugin-first では「プラグイン配列 + config の組み立てレシピ」 |
| **temperament（気質）** | 人格と自発性を統合した単一設定層。人格プロンプト生成と気づき閾値の両方に流れ込む |
| **認知ループ (Agent Core)** | 記憶読出し → 文脈構築 → モデル呼出し → ツール実行 → 記憶書込み のループ。コアが持つ |
| **Policy Gate** | 不可逆・対外アクションを決定論的 allowlist で判定する関門。LLMの判断に委ねない |
| **config_version（公開版）** | 設定の下書き→公開の2段階管理。公開ごとに不変の版を発行し、各実行が版をpinする |

## 記憶（メタファー ↔ 技術）

| メタファー | 技術実装 |
|---|---|
| **メモ帳** | スレッド単位の短期ノート（TTL付き、既定7日）。`notes` テーブル |
| **日記** | 夜間バッチが書く日次エントリ（イベント分節）。`journal_entries` |
| **本棚 + 索引カード** | キュレートされた知識 + エンティティリンク。`books` / `entities` |
| **書庫** | 減衰スコアで沈んだ記憶のコールドストレージ（`status='archived'`。削除はしない） |
| **睡眠** | 夜間の非同期コンソリデーション（03:00 JST バッチ） |
| **忘却曲線** | `strength ← strength × exp(-λ × days_since_recall)`。想起で強化 |
| **手帳（プレイブック）** | タスクパターン別の手順 + 確信度。`playbooks` |
| **deep_recall** | 書庫・日記全文の低速検索ツール（「思い出す努力」） |

## 気づき・自発性

| 用語 | 意味 |
|---|---|
| **気づき** | Slackイベント等から「関連度 × 緊急度 × 役に立てる確信度」で導く自発性 |
| **Finding** | 気づきを一級データ化した永続レコード（事実 + 根拠 + 提案アクション + state） |
| **finding_key** | kind + 主体 + 理由から決定的に生成する dedup キー |
| **完全性契約** | `SourceResult(complete/partial/failed/unauthorized)`。「動きなし」と言えるのは complete のときだけ |
| **セルフイシュー** | 個体が自分の基盤の不具合を検知して自リポにIssue起票する機能（`kind='platform_bug'`） |
| **3モード** | `off` → `dryrun`（投稿はログ/管理chのみ）→ `live`。自発行動の段階解禁 |
| **遠慮レートリミッタ** | 自発発言の上限/日・同一スレッド再介入禁止・静音時間 |

## プラグイン（plugin-first）

| 用語 | 意味 |
|---|---|
| **RussellPlugin** | プラグイン契約。`{ id, name, setup(ctx) }` のみ。種別フィールドは持たない |
| **AgentContext** | コアが提供するレジストリ群の束。プラグインが `setup(ctx)` で受け取る |
| **surface（通信面）** | 通信面プラグイン。Slack / CLI / Web など。**Slack はこの一種** |
| **equipment（装備）** | 外部システムへの能力 = MCP接続 + scope + danger_level + 効果分類 |
| **効果分類** | `read` / `internal_write` / `external_write` / `external_send` / `irreversible_write`。未分類は default deny |
| **OperationResult** | 書き込み結果 `succeeded` / `rejected` / `unknown`。unknown の blind retry 禁止 |
| **習熟度 (proficiency)** | 装備×個体ごとに育つ値。低いとHITL頻度↑、高いと確認スキップ |
| **dispatcher** | 静的cronでなく固定間隔tickで期限到来ルーティンをclaimする実行基盤 |
| **信頼ラベル** | `trusted` / `untrusted`。外部由来テキストはuntrusted、特権ツール引数に入るとブロック |
| **キルスイッチ** | `/russell stop` + envフラグで全自発行動を即凍結（個体単位・全体） |

## 実装フェーズ

| フェーズ | スコープ |
|---|---|
| **P0** | 会話とメモ帳（mention応答のみ） |
| **P1** | 睡眠と日記（夜間バッチ・忘却曲線・日報投稿） |
| **P2** | 習慣（ビルトインルーティン3種・本棚Web UI） |
| **P3** | 気づきと成長（Findingモデル・playbook・dryrun→live） |
| **P4**（将来） | 2個体ディスカッション機能・管理画面 |

## 外部参照

| 用語 | 意味 |
|---|---|
| **Frank v2** | 実運用済みの別プロダクト。Findingモデル・完全性契約・3モード・dispatcher・公開版設定・効果分類などの実証パターン提供元 |
| **usketch** | 同一モノレポ親のホワイトボードアプリ。PluginParty アーキテクチャの手本（`@edv4h/usketch-*`） |
| **MAGMA / Mem0 / CompassMem / Reflexion / FIDES** | 記憶・セキュリティ設計が参照する研究/手法 |
