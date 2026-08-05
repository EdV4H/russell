# データモデル

Russell の永続化は **Postgres + pgvector** に1本化する。記憶・キュー（pg-boss）・監査を1つに同居させ、
マイクロサービス化しない（設計書 [`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §2・§11）。
本章は §3.1・§6.1・§6.2・§8.2・§9.1 に散在するテーブル定義を1か所に集約したリファレンス。

> [!NOTE]
> plugin-first では、これらのテーブルにアクセスするのは主に `memory-pg` などの**基盤プラグイン**であり、
> コアや他プラグインは `ctx.services.get('memory')` 等の capability 経由で触れる。テーブルは実装詳細。

> [!IMPORTANT]
> **起動時 CREATE TABLE はしない**（§11）。スキーマ変更は `@edv4h/russell-migrate`（`pnpm migrate`）で
> **expand → backfill → contract** の3段で行う（既存カラムを壊さず追加 → データ移行 → 旧構造撤去）。
> 実装と手順は [`../reference/34-migrations.md`](../reference/34-migrations.md)。**本章の SQL は仕様の記述**であり、
> 実際に流れるのは各プラグインの `migrations.ts` に置かれた版（適用済みは不変・checksum で改変を検出）。
> 個体ごとの記憶分離のため、記憶テーブル群（notes/books/journal_entries/playbooks 等）には `agent_id` を付与する（§8.4）。

## 記憶（§3.1）

```sql
-- メモ帳：作業中の走り書き。スレッド/タスク単位。TTL 既定7日
CREATE TABLE notes (
  id UUID PRIMARY KEY,
  context_id TEXT NOT NULL,        -- slack thread_ts / task id
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,          -- 既定7日
  consolidated BOOLEAN DEFAULT false
);
```

```sql
-- 日記：夜間バッチが書く。1日1エントリ + イベント分節（エージェント自身は書けない）
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  narrative TEXT NOT NULL,     -- その日の物語（要約）
  events JSONB NOT NULL,       -- [{summary, participants, outcome, lesson?}]
  embedding VECTOR(1024)
);
```

```sql
-- 本棚：キュレートされた知識。「本」= 元情報 + 読書カード + 書き込み。strength で忘却曲線を管理
CREATE TABLE books (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,          -- URL / slack permalink / file
  card TEXT NOT NULL,   -- 読書カード（エージェント自身の要約）
  marginalia JSONB DEFAULT '[]',    -- 後から追記される書き込み
  shelf TEXT DEFAULT 'general',     -- 棚 = カテゴリ
  strength REAL DEFAULT 1.0,        -- 記憶強度（忘却曲線）
  recall_count INT DEFAULT 0,
  last_recalled_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active',     -- active | archived（書庫）
  embedding VECTOR(1024)
);
```

```sql
-- 索引カード：エンティティ（人・プロジェクト・システム）
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,                        -- person | project | system | ...
  aliases TEXT[] DEFAULT '{}',
  summary TEXT,
  embedding VECTOR(1024)
);
```

```sql
-- エンティティリンク：本・日記・メモへの参照（意味記憶のグラフ）
CREATE TABLE entity_links (
  entity_id UUID REFERENCES entities(id),
  ref_type TEXT,                    -- book | journal | note
  ref_id UUID,
  PRIMARY KEY (entity_id, ref_type, ref_id)
);
```

```sql
-- 手帳：プレイブック（手続き記憶）。confidence が成功/失敗で育つ
CREATE TABLE playbooks (
  id UUID PRIMARY KEY,
  task_pattern TEXT NOT NULL,       -- 「週次レポート作成」など
  steps JSONB NOT NULL,             -- 手順 + コツ + 落とし穴
  confidence REAL DEFAULT 0.3,
  success_count INT DEFAULT 0,
  failure_count INT DEFAULT 0,
  embedding VECTOR(1024)
);
```

記憶テーブルの意味づけは [`12-memory-system.md`](./12-memory-system.md)、忘却曲線の適用は
[`17-habits-and-sleep.md`](./17-habits-and-sleep.md)。

## 習慣・関心（§3.1）

```sql
-- 習慣：dispatcher が claim するルーティン登録簿（builtin | learned）
CREATE TABLE routines (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,             -- ルーティン実行時の指示
  origin TEXT DEFAULT 'builtin',    -- builtin | learned
  enabled BOOLEAN DEFAULT true
);
```

```sql
-- 関心プロファイル：気づきモジュールが参照。夜間バッチが再重み付け
CREATE TABLE interests (
  topic TEXT PRIMARY KEY,
  weight REAL DEFAULT 0.5,
  source TEXT                       -- role | learned
);
```

`routines` の実行基盤（dispatcher）は [`17-habits-and-sleep.md`](./17-habits-and-sleep.md)。

## 監査（§3.1）

```sql
-- 監査ログ：全アクション追記専用。trust_label で来歴を残す
CREATE TABLE event_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  actor TEXT, action TEXT, payload JSONB,
  trust_label TEXT                  -- trusted | untrusted
);
```

## 気質・設定（§6.1）

```sql
-- 気質：人格プロンプト生成と気づき閾値の両方に流れ込むグローバル設定
CREATE TABLE temperament (
  key TEXT PRIMARY KEY,        -- グローバル設定
  value JSONB NOT NULL
);
```

```sql
-- チャンネル別上書き：「雑談は饒舌、実務は控えめ」を temperament 上書きで表現
CREATE TABLE channel_settings (
  channel_id TEXT PRIMARY KEY,
  overrides JSONB NOT NULL     -- チャンネル別の上書き
);
```

temperament / config_version の公開版方式は [`18-presets-and-temperament.md`](./18-presets-and-temperament.md)。

## 気づき（§6.2）

```sql
-- Finding：気づきを一級データ化した永続レコード（事実 + 根拠 + 状態）
CREATE TABLE findings (
  id UUID PRIMARY KEY,
  agent_id UUID REFERENCES agents(id),
  finding_key TEXT NOT NULL,     -- kind+主体+理由から決定的に生成（dedup・新旧比較の恒等キー）
  kind TEXT NOT NULL,            -- 'deadline_risk' | 'doc_drift' | 'decision_detected' | 'platform_bug' | ...
  reason_code TEXT NOT NULL,     -- 判定理由の機械可読コード
  facts JSONB NOT NULL,          -- 導出に使った事実（値 + 取得元 + 取得時刻）
  evidence JSONB NOT NULL,       -- 根拠へのソース参照（Slack permalink等）
  proposed_action TEXT,
  state TEXT DEFAULT 'detected', -- detected / notified / acknowledged / resolved / suppressed
  config_version TEXT NOT NULL,  -- どの設定版で出た気づきか（再現性）
  detected_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_id, finding_key)
);
```

Finding モデルの意味づけは [`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)。

## 個体（§8.2）

```sql
-- 個体：素体 + プリセット + 個体別上書き。記憶テーブル群は agent_id で分離
CREATE TABLE agents (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,          -- 個体名（例：Bob、詩織）
  preset TEXT NOT NULL,        -- プリセットID
  overrides JSONB DEFAULT '{}' -- 個体別の上書き
);
```

プリセットと個体の関係は [`18-presets-and-temperament.md`](./18-presets-and-temperament.md)。

## 装備・支給台帳（§9.1）

```sql
-- 装備：MCP接続 + スコープ + 危険度。台帳への登録だけで追加でき、本体コード変更不要
CREATE TABLE equipment (
  id TEXT PRIMARY KEY,           -- 'slack' | 'github' | 'notion' | 'terminal'
  mcp_server TEXT NOT NULL,      -- 接続先MCPサーバー定義
  scopes JSONB NOT NULL,         -- 装備内の細分権限（例: notionはread/writeを別装備に）
  danger_level INT DEFAULT 0     -- 0-3。2以上は使用のたびHITL承認
);
```

```sql
-- 支給台帳：どの個体にどの装備を支給したか。Policy Gate の allowlist はここから生成
CREATE TABLE issuances (
  agent_id UUID REFERENCES agents(id),
  equipment_id TEXT REFERENCES equipment(id),
  proficiency REAL DEFAULT 0.2,  -- 習熟度（成功で育つ）
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_id, equipment_id)
);
```

装備・習熟度・効果分類の意味づけは [`14-equipment.md`](./14-equipment.md)、
allowlist との接続は [`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)。

## テーブル一覧

| テーブル | 由来 | 目的 |
|---|---|---|
| `notes` | §3.1 | メモ帳（短期・TTL） |
| `journal_entries` | §3.1 | 日記（夜間バッチ専用） |
| `books` | §3.1 | 本棚（意味記憶・忘却曲線） |
| `entities` | §3.1 | 索引カード（エンティティ） |
| `entity_links` | §3.1 | エンティティ ↔ 本/日記/メモ のリンク |
| `playbooks` | §3.1 | 手帳（手続き記憶・confidence） |
| `routines` | §3.1 | 習慣（dispatcher 登録簿） |
| `interests` | §3.1 | 関心プロファイル |
| `event_log` | §3.1 | 監査ログ（追記専用・trust_label） |
| `temperament` | §6.1 | 気質（グローバル設定） |
| `channel_settings` | §6.1 | チャンネル別上書き |
| `findings` | §6.2 | Finding（気づきの永続レコード） |
| `agents` | §8.2 | 個体 |
| `equipment` | §9.1 | 装備（MCP + scope + danger） |
| `issuances` | §9.1 | 支給台帳（習熟度） |

## 関連

- ドメイン型（EffectClass / OperationResult / SourceResult 等）：[`../reference/32-domain-types.md`](../reference/32-domain-types.md)
- 記憶システム：[`12-memory-system.md`](./12-memory-system.md)
- 用語集：[`../getting-started/02-glossary.md`](../getting-started/02-glossary.md)
