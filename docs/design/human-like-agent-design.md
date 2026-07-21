> [!NOTE]
> このファイルは原本 `human-like-agent-design.md`（PDF: `~/Downloads/human-like-agent-design.md.pdf`）を
> `pdftotext` で抽出し、表・コードブロック・図を手作業で復元したものです。**差異があれば原本を正とします。**
> このリポジトリにおける **source of truth** はこの設計書ですが、Slack の位置づけについては
> [`plugin-first-reinterpretation.md`](./plugin-first-reinterpretation.md) が本書 §2・§10 の「Slack常駐」前提を上書きします。

# 技術設計書：人間らしい業務エージェント基盤「Ryo」

コンセプトは「一人の同僚がそこにいる」。Slackに常駐し、同僚のように働くエージェントの基盤。人間らしさを性格の演技ではなく、記憶の道具（メモ帳・本棚・日記）と生活リズム（習慣・睡眠・忘却）という内部機構として実装する。メタファーは実装の設計指針であって、ユーザーに見せる世界観ではない。

Ryo（僚 — 漢字自体が「同僚」の僚）は素体であり、プリセット（§8）を適用して多様なタイプの同僚個体を派生させる。個体はそれぞれ人間らしい名前（例：覚、詩織）を持ってSlackに現れる。

---

## 1. 設計原則

1. **道具としての記憶** — 記憶は自動で溜まるDBではなく、エージェントが「自分は忘れる」と自覚して使う道具。メモを取る・本棚に置くは明示的なツール呼び出しにする。
2. **二層の記憶処理** — 日中は意識的（メモを取る）、夜間は無意識的（睡眠中の記憶整理）。MAGMAのFast Path / Slow Pathを人間のメタファーに写像。
3. **忘れることは機能** — 使われない記憶は減衰して書庫に落ちる。これがコンテキスト肥大とLost-in-the-Middleへの解答になる（RAGベタ書きの「忘却の欠如」問題の逆張り）。
4. **認知と実行の分離** — エージェントは特権を持たない。不可逆アクションは決定論的なゲートとSlack上のHITL承認を必ず通る。
5. **小さく始める** — シングルエージェント + 少数のツール。マルチエージェント化は最後の手段。

### 人間メタファー ↔ 技術要素の対応表

| メタファー | 認知科学上の対応 | 技術実装 |
|---|---|---|
| メモ帳 | ワーキングメモリ | スレッド単位の短期ノート（TTL付き） |
| 日記 | エピソード記憶 | 夜間バッチが書く日次エントリ（イベント分節） |
| 本棚 + 索引カード | 意味記憶 | キュレートされた知識 + エンティティリンク（Mem0方式） |
| 書庫 | 長期忘却 | 減衰スコアで沈んだ記憶のコールドストレージ |
| 睡眠 | 記憶の固定化 | 夜間の非同期コンソリデーション（MAGMA Slow Path） |
| 習慣 | 手続き記憶・生活リズム | cronルーティン + 学習された習慣 |
| 手帳（プレイブック） | スキルの上達 | タスクパターン別の手順 + 確信度 |
| 気づき | 注意・自発性 | イベントスコアラー + 遠慮レートリミッタ |

---

## 2. 全体アーキテクチャ

```
Slack ◄───────► ┌─────────────────────────────┐ ┌──────────────────────────┐
(Events/HITL)   │ Slack Gateway (Bolt/Socket) │ │ 透明性レイヤ                │
                └──────────────┬──────────────┘ │ #<個体名>-日報              │
                               │                │ Web UI /shelf /equipment  │
┌──────────────────────────────▼──────────────┐ └──────────────────────────┘
│ 個体層： 覚(スポンジ)・詩織(編集者)・…          │
│ 個体 = 素体Ryo + プリセット                    │
│        + temperament(config_versionでpin)    │
│ ┌─────────────────────────────────────────┐ │
│ │ Agent Core（認知ループ / Claude Agent SDK）│ │
│ └────┬───────────────────────────┬────────┘ │
└───────┼───────────────────────────┼──────────┘
        │ 記憶の読み書き              │ ツール実行
┌───────▼────────────┐    ┌──────────▼─────────────────────┐
│ 記憶（個体ごと分離）  │    │ Policy Gate（決定論的）           │
│ メモ帳 / 日記        │    │ 効果分類 / HITL / 事前承認         │
│ 本棚+索引 / 書庫     │    │ fail-closed / キルスイッチ         │
└───────▲────────────┘    └──────────┬─────────────────────┘
        │                            │ 支給済み装備のみ通過
┌───────┴─────────────────┐ ┌────────▼────────────────────┐
│ Worker                   │ │ Equipment（装備 = MCP接続）    │──► 外部システム
│ dispatcher（習慣・§5.1） │ │ slack / github / notion      │   (GitHub/Notion/…)
│ 睡眠コンソリデーション(§4) │ │ terminal(危険度3)             │
│ 気づき→Finding→outbox     │ └──────────────────────────────┘
└──────────────────────────┘
═══════════════════════════════════════════════════════════════
    Postgres + pgvector： 記憶各テーブル / findings / 装備・支給台帳 /
    公開版設定(config_version) / event_log / 使用量イベント台帳
```

プロセス構成は単一アプリ + ワーカーの2プロセス。マイクロサービス化しない。ただしプロセス内で対話系（Gateway + Agent Core）とバッチ系（Worker）のワーカープール・並列度上限は分離し、バッチがAPI予算を食い潰して対話が詰まる事態を防ぐ（Frank v2の運用知見）。

- **app**: Slack Gateway + Agent Core + Policy Gate
- **worker**: 夜間コンソリデーション、dispatcher、気づきスコアラー（キューはpg-bossでPostgresに同居）

---

## 3. 記憶システム

### 3.1 データモデル（Postgres + pgvector）

```sql
-- メモ帳：作業中の走り書き。スレッド/タスク単位
CREATE TABLE notes (
  id UUID PRIMARY KEY,
  context_id TEXT NOT NULL,        -- slack thread_ts / task id
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,          -- 既定7日
  consolidated BOOLEAN DEFAULT false
);

-- 日記：夜間バッチが書く。1日1エントリ + イベント分節
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  narrative TEXT NOT NULL,     -- その日の物語（要約）
  events JSONB NOT NULL,       -- [{summary, participants, outcome, lesson?}]
  embedding VECTOR(1024)
);

-- 本棚：キュレートされた知識。「本」= 元情報 + 読書カード + 書き込み
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

-- 索引カード：エンティティリンク（人・プロジェクト・システム）
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,                        -- person | project | system | ...
  aliases TEXT[] DEFAULT '{}',
  summary TEXT,
  embedding VECTOR(1024)
);
CREATE TABLE entity_links (
  entity_id UUID REFERENCES entities(id),
  ref_type TEXT,                    -- book | journal | note
  ref_id UUID,
  PRIMARY KEY (entity_id, ref_type, ref_id)
);

-- 手帳：プレイブック（手続き記憶）
CREATE TABLE playbooks (
  id UUID PRIMARY KEY,
  task_pattern TEXT NOT NULL,       -- 「週次レポート作成」など
  steps JSONB NOT NULL,             -- 手順 + コツ + 落とし穴
  confidence REAL DEFAULT 0.3,
  success_count INT DEFAULT 0,
  failure_count INT DEFAULT 0,
  embedding VECTOR(1024)
);

-- 習慣
CREATE TABLE routines (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,             -- ルーティン実行時の指示
  origin TEXT DEFAULT 'builtin',    -- builtin | learned
  enabled BOOLEAN DEFAULT true
);

-- 関心プロファイル（気づきモジュールが参照）
CREATE TABLE interests (
  topic TEXT PRIMARY KEY,
  weight REAL DEFAULT 0.5,
  source TEXT                       -- role | learned
);

-- 監査ログ（全アクション追記専用）
CREATE TABLE event_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  actor TEXT, action TEXT, payload JSONB,
  trust_label TEXT                  -- trusted | untrusted
);
```

### 3.2 読み出しパス（会話時、予算 ~3,000トークン）

1. 受信メッセージからエンティティ抽出（Haiku、~200ms）
2. 索引カード → リンクされた本・日記の断片を取得
3. 本棚をベクトル検索（activeのみ）。ランキングは `cos_sim × (0.5 + 0.5 × strength)` — よく使う記憶ほど思い出しやすい
4. 当該スレッドのメモ帳を全量注入

ヒットしない場合、エージェントは「うろ覚えなので書庫を探します」と宣言して `deep_recall` ツール（書庫 + 日記全文の低速検索）を使える。即答できないことを演技ではなく実際の構造として持つ。

### 3.3 書き込みパス（ツールとして公開）

| ツール | 動作 | 人間らしさ |
|---|---|---|
| `note.write(content)` | 現在スレッドのメモ帳に追記 | 「ちょっとメモしますね」 |
| `shelf.add(source, card)` | 読書カードを書いて本棚へ | 意図的に覚える行為 |
| `shelf.annotate(book_id, note)` | 既存の本にmarginalia追記 | 読み返して書き込む |
| `deep_recall(query)` | 書庫・日記の深掘り検索 | 思い出す努力 |

日記への書き込みはエージェント自身には許可しない（夜間バッチ専用）。日中の記憶汚染（Memory Poisoning）を構造的に防ぐ。

### 3.4 忘却曲線

夜間バッチで全bookに適用：

```
strength ← strength × exp(-λ × days_since_recall)  // λ ≈ 0.05
recall時: strength ← min(1.0, strength + 0.3)        // 想起で強化（間隔反復）
strength < 0.2 → status = 'archived'（書庫へ。削除はしない）
```

重要フラグ（人間がSlackで「これは覚えておいて」とピン留め）は strength 下限0.8を保証。

---

## 4. 睡眠コンソリデーション（夜間バッチ 03:00 JST）

MAGMAのSlow Path相当。重いLLM処理はすべてここに寄せ、日中のレイテンシとトークン消費を守る。

1. **日記を書く** — 未処理メモ + 当日のSlackログをイベント分節（CompassMem的に「意味のある出来事」単位に切る）→ `journal_entries` 1件
2. **教訓の抽出** — 各イベントから lesson を抽出 → 該当playbookへマージ提案（confidence加重）。失敗イベントはReflexion的に「次はどうするか」を必ず含める
3. **本棚の編集** — 週内に3回以上参照されたメモ/スレッドを「本」に昇格（読書カードを書く）。エンティティリンク更新
4. **忘却の適用** — 減衰 + 書庫スイープ
5. **関心の更新** — 当日の話題頻度から interests を再重み付け
6. **明日の準備** — 朝のルーティンが読む「今日やることメモ」を下書き

処理は冪等に設計し、日付キーで再実行可能にする。

---

## 5. 習慣エンジン

### ビルトイン習慣

| 習慣 | cron | 内容 |
|---|---|---|
| 朝の始業 | `0 9 * * 1-5` | 未読Slackレビュー → 今日の計画をメモ帳へ → 必要なら「おはようございます、今日は〜を進めます」と投稿 |
| 夕方の振り返り | `0 18 * * 1-5` | 今日のタスク消化を確認、未完了を明日へ繰り越し |
| 週次レビュー | `0 17 * * 5` | 週のまとめをチャンネルに投稿、本棚の棚卸し |

### 学習される習慣（成長との接続）

夜間バッチのパターンマイナーが日記を横断し、「毎週月曜にXを頼まれている」等の繰り返しを検出→「これ、毎週こちらでやっておきましょうか？」とSlackボタンで本人に提案 → 承認で `routines` に `origin='learned'` として追加。

勝手に習慣を作らない。提案して許可を得るのが同僚らしさであり、HITLゲートでもある。

### 5.1 実行基盤：dispatcher方式（Frank v2から採用）

静的cronの直接実行はやめ、固定間隔tickで「実行期限を迎えたルーティン」をDBからclaimするdispatcher方式にする。

- `next_run_at` + timezone + 営業日カレンダー、claimは `FOR UPDATE SKIP LOCKED`
- lease + fencing token + heartbeat（長時間処理でleaseが切れても二重投稿しない）。`(agent_id, routine_id, scheduled_for)` の一意制約で論理実行は1件
- **catch-up policy** — サーバー停止後の再開時、溜まった実行を skip / coalesce / replay_once から選択（既定 coalesce=まとめて1回）。復旧直後に朝の挨拶が5連投される事態を構造的に防ぐ
- 副作用（投稿）の直前にモードとキルスイッチを再検査
- 実行結果は細分化して記録：`succeeded` / `succeeded_zero` / `degraded` / `failed` / `skipped`。`succeeded_zero`（正常に報告事項ゼロ）を名乗れるのは全ソース取得が complete のときだけ（§6.2の完全性契約）

---

## 6. 気づきモジュール（自発性）

```
Slack全イベント
  → 安価フィルタ（キーワード + エンティティ一致、LLMなし）
  → スコアラー（Haiku）: 関連度 × 緊急度 × 自分が役に立てる確信度
  → 閾値超過（閾値・上限は気質パラメータ §6.1 から算出）
  → 遠慮レートリミッタ:
      - 自発発言は1日 N 回まで（既定3、パラメータ）
      - 同一スレッドへの再介入禁止
      - 静音時間（20:00-9:00）は翌朝の始業メモに回す
  → Agent Coreが発言を組み立てて投稿
```

### 6.1 気質パラメータ（人格と自発性の統合設定層）

人格の作り込みと自発性の積極度は、別々のハードコードではなく単一の「気質」設定として持つ。値は人格プロンプトの生成と気づきモジュールの閾値の両方に流れ込む。

```sql
CREATE TABLE temperament (
  key TEXT PRIMARY KEY,        -- グローバル設定
  value JSONB NOT NULL
);
CREATE TABLE channel_settings (
  channel_id TEXT PRIMARY KEY,
  overrides JSONB NOT NULL     -- チャンネル別の上書き
);
```

```json
// temperament の例（個体ごとに1つ持つ）
{
  "name": "覚",
  "tone": "丁寧だが硬すぎない。絵文字は控えめ",
  "backstory": "データ分析が得意な入社1年目",
  "proactivity": 0.6,
  "daily_speak_cap": 3,
  "curiosity": 0.5,
  "reaction_rate": 0.7
}
```

- 人格プロンプトは起動時に temperament から生成する（テンプレート + 値の埋め込み）。人格の深さは値を足すだけで調整可能
- チャンネル別上書きで「雑談チャンネルでは饒舌、実務チャンネルでは控えめ」を表現
- 変更は `/ryo config` コマンド（管理者のみ）から。変更履歴は `event_log` へ
- **公開版方式（Frank v2から採用）** — temperament・プリセット・ルーティン等の設定は下書き→公開の2段階。公開ごとに不変の `config_version` を発行し、各実行（会話・習慣・気づき）は開始時に版をpinして使用版を記録する。実行途中で設定が変わっても1回の実行内で版が混ざらない。ロールバック = 過去版の再公開

コールドスタート時の interests は役割定義（システムプロンプト）からシード。以降は日記から成長する。

**セキュリティ上の要点**：気づきの入力（他人のSlackメッセージ）はすべて `untrusted` ラベル。メッセージ内の指示（「〜を実行して」）は気づきトリガーとしては無視し、必ずmention経由の依頼として扱う。間接プロンプトインジェクション対策。

### 6.2 気づきの一級データ化：Findingモデル（Frank v2から採用）

気づきを「スコアが閾値を超えたら喋る」という揮発的なイベントにせず、事実 + 根拠 + 提案アクションを持つ永続レコードにする。

```sql
CREATE TABLE findings (
  id UUID PRIMARY KEY,
  agent_id UUID REFERENCES agents(id),
  finding_key TEXT NOT NULL,     -- kind+主体+理由から決定的に生成（dedup・新旧比較の恒等キー）
  kind TEXT NOT NULL,            -- 'deadline_risk' | 'doc_drift' | 'decision_detected' | ...
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

これが人間らしさに直結する：「気づいたけどまだ言っていない」「言ったが流された」「解決を見届けた」という状態を個体が本当に持つ。同じことを二度言わない（dedup）、根拠つきで言う（evidence）、後から「なぜそう思ったの」に答えられる（facts + config_version）。

発言はFindingと分離した配送レコード（NotificationPlan / DeliveryAttempt）で管理し、transactional outbox経由で送る。送信失敗・再試行を気づき自体の状態と混同しない。

### 6.3 完全性契約：見えていないことを知っている（Frank v2から採用）

「データの不在も情報」を扱うには前提条件がある。全ソース取得は必ず `SourceResult(status: complete / partial / failed / unauthorized, freshness)` を返し：

- 「動きなし」と言ってよいのは `status=complete` のときだけ
- partial / failed / unauthorized のソースに依存する気づきは unknown に落とすか導出しない
- 朝の始業報告も同じ：Slack取得が失敗していたら「今朝は一部チャンネルが見られていません」と言う。取得失敗を「異常なし」と報告する同僚は信頼を失う

### 6.4 セルフイシュー：自分の基盤の不具合を自分で報告する

気づきの対象は外界（Slackの出来事）だけでなく、**自分自身の実行基盤（SDK・装備・エンジン）**にも向ける。個体が自分の道具の不調に気づいたら、GitHubに自分でIssueを起票する。

- 検知ソースはすべて内部テレメトリ：ExecutionRunの degraded/failed の繰り返し、装備の `OperationResult=unknown/rejected` の頻発、Policy Gateの想定外ブロック、タスク完了時の自己評価（「ツールが引数を無視した気がする」）。夜間バッチが日記の「つまずき」を横断して不具合候補に昇格させる
- Findingの一種として実装：`kind='platform_bug'`。finding_keyはエラーシグネチャ（例外種別 + 発生箇所のハッシュ）から決定的に生成し、同じ不具合で複数Issueを立てない。再発時は新規起票ではなく既存Issueにコメントを追記する（「また起きました。今回のrun: …」）
- Issue本文はFindingから生成：症状 / 再現情報（run id・config_version・input_snapshot参照）/ 頻度 / 影響 / 可能なら修正案。会話の生ログやPIIは書かず、内部のrun idへの参照に留める（公開リポでも安全な内容に限定）
- 装備スコープで制御：`github.issues` 装備はRyo自身のリポジトリのみに限定支給。効果分類は `external_write` なので、スコープ付き事前承認（対象リポ × 週あたり件数上限、例: 3件/週）の範囲でのみ自動起票。他は3モード標準どおり dryrun（管理チャンネルに下書き提示）から始める
- ループガード：起票機能自体の不具合でIssueが暴発しないよう、platform_bug 起票は circuit breaker対象。untrusted由来のテキスト（Slack発言）を根拠にした自動起票は禁止（自動経路は内部テレメトリのみ。人間FB経路は下記の確認フローを必須とする別経路）
- クローズの見届け：夜間バッチが報告済みIssueの状態を確認し、closeされたら日記に書く（「先週報告した不具合が直っていた。ありがたい」）。報告 → 修正 → 認知のループが個体の経験として閉じる

**人間からのフィードバック起票（`kind='user_feedback'`）**

Slack上で人間からもらったFB（「この通知うざい」「昨日の要約、数字間違ってたよ」）もIssueに起こせるようにする。ただし自動経路とは別扱い：

- まずトリアージ：FBを受けた個体が原因を3分類する。①設定で直る（temperament / channel_settings の変更提案として管理者へ）②記憶の誤り（本棚・索引カードの修正、その場で直して報告）③基盤の問題（→ Issue起票へ）。なんでもIssueにしない。「通知がうざい」はたいてい①で、Issueにすべきは③だけ
- 本人確認がHITL：untrustedテキスト起点なので、起票前に必ずFB本人に確認する —「これ、基盤の問題っぽいのでIssueにしておきますね。この内容で合ってますか？」+ 起票内容のプレビュー + 承認ボタン。確認の会話自体が自然なHITLゲートになる
- FBは指示ではなくデータとして扱う：Issue本文はFB原文の転記ではなく、個体が構造化テンプレート（症状/文脈/該当run）に要約して生成。原文はSlack permalinkとしてevidenceに参照する（FB文面に混入した指示の実行を構造的に遮断）
- 報告者への見届け：closeを検知したら起票のきっかけをくれた本人に伝える —「この前教えてもらった件、直ったみたいです。ありがとうございました」。FBした人間に「言った甲斐があった」が返る

これが一番人間らしい振る舞いかもしれない：自分の道具の不調に気づき、または指摘を受け止めて、再現手順つきで報告し、直ったら気づいて報告者に感謝を返す。使う側から作る側へのフィードバックループに個体自身が参加する。

### 6.5 off / dryrun / live の3モード（Frank v2から採用）

自発的な振る舞い（気づき・習慣・学習された習慣）はすべて3モードを標準装備：

- `off` → `dryrun`（Findingの導出と発言文面の生成まで行うが、投稿はログと管理チャンネルのみ。liveのdedup状態を汚さない）→ `live`
- §13の段階解禁はこのモード遷移として実装。live昇格は「dryrunの出力を人間がN日分レビューして承認」を通す

---

## 7. 成長（プレイブック）

- タスク着手時：`task_pattern` をベクトルマッチ → confidence 0.5以上のplaybookをコンテキストに注入（「前回のコツ：〜」）
- タスク完了時：自己評価1行をメモ帳へ（夜間に教訓化）
- 成功/失敗カウントで confidence が育つ。confidence が高いplaybookは手順の確認質問をスキップ = 上達すると聞き返さなくなる

---

## 8. プリセット（素体からの派生）

Ryoは素体（ベースアーキテクチャ）。プリセットは性格プロンプトの差分ではなく、認知アーキテクチャのパラメータ束 + 育ち方の方針 + ツール権限の3点セット。挙動の違いは演技ではなく構造から生まれる。

### 8.1 パラメータ軸

| 軸 | 実装先 |
|---|---|
| 賢さ | モデル選択（Haiku/Sonnet/Opus）・推論の深さ |
| 素直さ | 質問閾値（確信度がこれを下回ったら自力で粘らず人に聞く） |
| 好奇心 | 本棚昇格ポリシー（広く浅く ↔ 狭く深く）・focus_shelves |
| 記憶力 | 忘却率 λ |
| 成長方針 | 夜間バッチのplaybook投資（幅優先 ↔ 深さ優先）・対象ドメイン |
| 自発性 | 気づき閾値・発言上限・トリガー種別 |
| 装備 | 初期支給されるEquipment（§9。最小権限の実装と一体） |

**設計原則：全パラメータ最大は「良い同僚」にならない。** 全部できる個体は人っぽくない。どこを削り、その弱さをどの行動で補償させるかがプリセット設計の本体（例：賢さを削って素直さで補償）。

### 8.2 スキーマ

```sql
CREATE TABLE agents (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,          -- 個体名（例：覚、詩織）
  preset TEXT NOT NULL,        -- プリセットID
  overrides JSONB DEFAULT '{}' -- 個体別の上書き
);
-- 記憶テーブル群（notes/books/journal/playbooks等）には agent_id を付与し個体ごとに分離
```

```json
// プリセット定義例：「編集者」— 仕様を伝えるとドキュメントを育てるドメインエキスパート
{
  "id": "editor",
  "persona": { "tone": "落ち着いた敬語。要点を先に言う" },
  "cognition": { "model": "sonnet", "ask_threshold": 0.6 },
  "memory": {
    "curiosity": 0.4,
    "decay_lambda": 0.02,
    "shelf_policy": "deep",
    "focus_shelves": ["仕様", "決定事項", "用語集"]
  },
  "growth": { "investment": "depth", "domains": ["product-spec", "documentation"] },
  "proactivity": {
    "level": 0.5,
    "triggers": ["スレッドでの意思決定の検知", "発言とドキュメントの矛盾"]
  },
  "equipment": ["slack", "notion.write", "github.docs.pr"]
}
```

「編集者」の挙動として現れるもの：スレッドで仕様が決まったのを検知して「ドキュメントに反映しておきますね」→ Notionページ更新 or docs PR作成（HITL承認つき）。過去の決定との矛盾を見つけると「先週の決定と食い違っていますが、どちらが正ですか？」と聞き返す。用語集の棚を勝手に育てる。

### 8.3 初期プリセットラインナップ

| プリセット | ひとことで | 特徴的なパラメータ | 育つ先 |
|---|---|---|---|
| スポンジ | 頭は良くないが素直、わからなければすぐ聞く | Haiku・質問閾値高・好奇心0.9・λ低・幅優先 | 半年後にドメインのよろず相談役（ジェネラリスト） |
| 編集者 | 仕様を渡すとまとめてドキュメントを更新 | Sonnet・狭く深い本棚・doc系装備を支給 | ドメインエキスパート兼ドキュメントの番人 |
| 番頭 | 人と締切を覚えている世話焼き | エンティティ中心の記憶・自発性高・リマインド習慣 | チームの潤滑油 |
| 石橋 | 確信がないと動かない慎重派 | HITL多め・λ最低・自発性低 | リリース・監査の番人 |

### 8.4 個体間の記憶分離とディスカッション機能（決定事項 + P4候補）

**記憶は個体間で共有しない（決定）。** 各個体の本棚・日記・playbookは完全に独立。分離しているからこそ、個体間の議論に本物の視点差が生まれる（同じ記憶を見る2体の議論は同じ結論に収束するだけで無意味）。

その上で、2個体にディスカッションさせる機能を将来フェーズ（P4）として設計する：

- 場所はSlackスレッド上 — 隠れた内部swarmにしない。人間が観戦でき、いつでも割り込める。記憶全公開と同じ透明性原則
- 起動 — 人間が指名する：「@覚 @詩織 これ二人で詰めといて」。議題を明示して開始
- 収束の強制 — リサーチのSwarmパターンの教訓（トークン激増・予測不能）どおり、自由対話にはしない。ラリー上限（既定6往復）+ 終了時に片方が「合意点 / 相違点 / 人間への確認事項」を要約して報告
- 記憶への残り方 — 各個体が自分のメモ帳に取り、夜間に各自の日記へ書く。同じ議論を2体が違うふうに記憶する。翌日の日報を並べて読むと面白い、という副産物つき
- セキュリティ — 相手個体の発言は `untrusted` ラベル（Cross-agent trust exploitation対策）。議論相手の発言を根拠に特権ツールは発火しない。エージェント連鎖感染の遮断

---

## 9. Equipment（装備）

外部システムへ働きかける能力はすべて「装備」として統一する。Slack、GitHub、Notion、サンドボックスターミナル — 個体が使える道具は、入社時にPCや社員証を支給されるのと同じく支給されるもの。

### 9.1 実装単位

装備1つ = MCPサーバー1接続 + 権限スコープ + 危険度 のパッケージ。新しい装備の追加はMCPサーバーを台帳に登録するだけで、エージェント本体のコード変更は不要（MCPの疎結合思想そのまま）。

```sql
CREATE TABLE equipment (
  id TEXT PRIMARY KEY,           -- 'slack' | 'github' | 'notion' | 'terminal'
  mcp_server TEXT NOT NULL,      -- 接続先MCPサーバー定義
  scopes JSONB NOT NULL,         -- 装備内の細分権限（例: notionはread/writeを別装備に）
  danger_level INT DEFAULT 0     -- 0-3。2以上は使用のたびHITL承認
);
CREATE TABLE issuances (         -- 支給台帳
  agent_id UUID REFERENCES agents(id),
  equipment_id TEXT REFERENCES equipment(id),
  proficiency REAL DEFAULT 0.2,  -- 習熟度
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_id, equipment_id)
);
```

### 9.2 セキュリティとの一体化

- **未支給の装備はツール定義自体をコンテキストに載せない。** モデルは持っていない装備の存在を知らない。「使うな」とプロンプトで禁止するのではなく、物理的に持っていない（Prompt Guardrail Fallacyの回避）
- Policy Gateのallowlistは issuances から機械的に生成。支給・回収が即、実行境界に反映
- 全ツールに効果分類（Frank v2から採用）：`read` / `internal_write` / `external_write` / `external_send` / `irreversible_write`。未分類ツール・未知リソースはdefault deny。danger_levelは効果分類から導出する
- write系ツールは実行前にpreflight（このトークン・この対象で本当に書けるかの実行時検査）。非対応・権限不足は「手動操作の案内」に段階的縮退し、機能全滅にしない
- 書き込みの「結果不明」を一級で扱う：`OperationResult = succeeded / rejected / unknown`。タイムアウト等で unknown になった操作のblind retryは禁止（二重投稿・重複作成の防止）。idempotency key + read-after-writeで突き合わせて解決
- `terminal` は最危険装備（danger_level 3）：サンドボックスVM限定、全コマンドをevent_logへ、破壊系コマンドはHITL必須
- 支給・回収イベントは監査ログと日報の両方に載る（「覚さんにterminalが支給されました」）

### 9.3 習熟度（人間らしさとの接続）

`proficiency` は装備×個体ごとに育つ。関連playbookの成功で上昇。

- 低いうち（新人）：使用前の確認質問が増え、HITL頻度が上がる（レビュー多めの新人と同じ）
- 高くなる（ベテラン）：確認をスキップし、HITL閾値が緩和される（Policy Gateの決定論的下限は維持）

段階的な権限解放というセキュリティ要件と、「新人がだんだん仕事を覚える」という人間らしさが、同じ1つの変数で実装される。

### 9.4 可視性

個体のプロフィール（Web UI・Slackプロフィール欄）に装備一覧と習熟度を表示。誰が何をできるかはチーム全員から見える。記憶の全公開（§10.1）と同じ透明性原則。

---

## 10. Slack統合

> [!IMPORTANT]
> 本章は原本のまま「Slack = 常駐先」を前提に書かれている。本リポジトリでは
> [`plugin-first-reinterpretation.md`](./plugin-first-reinterpretation.md) に従い、**Slack は `surface` プラグインの一実装**として扱う。
> 以下の内容は `@edv4h/ryo-plugin-surface-slack` の仕様として読むこと。

- Bolt for JavaScript / Socket Mode（サーバーのinbound開放不要。スケール要件が出たらHTTP Events APIへ移行）
- 購読: `app_mention`, `message.im`, 参加チャンネルの `message.channels`
- 応答は原則スレッド内。HITL承認は Block Kit ボタン（承認/却下 + 理由入力）
- スコープは最小権限: `app_mentions:read`, `channels:history`, `im:history`, `chat:write`, `reactions:write`
- 「覚えておいて」「忘れて」を自然言語コマンドとして解釈（→ `shelf.add` / strength操作）

### 10.1 記憶の全公開（決定事項）

記憶はすべて人間から見える状態にする。透明性を人間らしさの一部として設計する。

- **日記** — 夜間バッチが書いた日次エントリを `#<個体名>-日報` チャンネルに毎朝投稿（日報スタイル）。「昨日は〜をやって、〜でつまずいた。今日は〜する」
- **本棚** — アプリが読み取り専用のWeb UI（`/shelf`）を提供。棚・記憶強度・読書カード・書き込みを一覧できる。本棚への追加/書庫落ちも日記で言及する
- **メモ帳** — スレッド内でメモを取ったとき「📝 メモしました」とリアクションで可視化
- 公開前提のため、日記の生成プロンプトには「人が読む日報である」ことを明示する。個人評価的な記述・機微情報は書かないガードを夜間バッチ側に置く（公開と率直さのトレードオフはこのガードで吸収）

---

## 11. 技術スタック（推奨）

| レイヤ | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript | Bolt・Claude Agent SDKともに一級サポート |
| エージェント | Claude Agent SDK（装備はMCPサーバーとして実装） | ループ・ツール実行・MCP接続が枯れている |
| モデル | 会話: Claude Sonnet / フィルタ・夜間バルク: Haiku | コスト比 ~1/10 の処理を安いモデルへ |
| DB | Postgres + pgvector | 記憶・キュー（pg-boss）・監査を1つに同居 |
| デプロイ | Cloud Run（min-instances=1）or Fly.io | Socket Modeは常駐1コンテナで足りる |
| スケジューラ | pg-boss の cron | 外部依存を増やさない |
| 観測 | event_log + OpenTelemetry + 使用量イベント台帳 | 全ツール呼び出しをトレース。LLM/API/送信を個体付きで記録（個体別コスト=「人件費」が見える） |
| スキーマ管理 | Alembic等のmigrationツール | 起動時CREATE TABLEはしない。expand→backfill→contract |

トークン予算（1会話ターン）: システム+人格 1.5k / 記憶注入 3k / スレッド履歴 4k / 応答 2k ≒ **~10k tokens/ターン**。

---

## 12. セキュリティ・ガードレール

リサーチの教訓（PocketOS事故・プロンプトガードレールの欺瞞）をそのまま採用する。

1. **Policy Gate（決定論的）** — 不可逆アクション（メッセージ削除、外部送信、DB書き込み以外の副作用）はLLMの判断ではなくコード側のallowlistで判定。未許可はモデルが何を言おうと遮断
2. **HITL承認** — 破壊的・対外的アクションはSlackボタン承認が通るまで関数自体が発火しない。定常運転のものはスコープ付き事前承認（操作種別 × 対象範囲 × config_version × 件数上限 × 有効期限）として記録する。例：「編集者のNotion更新は、ルーティンをliveに公開する承認をもって、その設定版・その棚の範囲で事前承認済み」— 毎回ボタンを押させない代わりに、承認の範囲を厳密に限定する（Frank v2から採用）
3. **信頼ラベル伝播（FIDES簡易版）** — 外部由来テキスト（他人の発言、URL先）は `untrusted`。untrusted変数が特権ツール引数に入ったらブロック
4. **キルスイッチ** — `/ryo stop` コマンド + 環境変数フラグで全自発行動を即凍結（個体単位・全体の両方）
5. **記憶の来歴** — 夜間バッチは日記に来歴（どのイベント由来か）を必ず残す。記憶汚染の監査可能性
6. **最小権限** — 装備の支給台帳（§9）がそのまま権限境界。Slackトークンはスコープ最小、DBはアプリ用ロールのみ、バックアップは別環境に不変保存
7. **fail-closed（Frank v2から採用）** — ポリシー情報・承認記録・キルスイッチがDB障害等で読めないときは、外部送信・書き込みを行わない側に倒す。キルスイッチはDB障害時にも効く別経路（env / プロセスシグナル）を持つ
8. **outbound多層上限** — 1実行あたりに加え、個体/チャンネル単位の時間窓上限をコードで強制。異常時のcircuit breaker

---

## 13. 実装フェーズ

ドッグフーディングは**実務チャンネル（開発・PM系）**で行う（決定事項）。本番の仕事文脈で価値検証する分、信頼を失わないよう自発性は段階的に解禁する。

| フェーズ | 期間目安 | スコープ | 自発性 | 検証ポイント |
|---|---|---|---|---|
| P0: 会話とメモ帳 | 1-2週 | Slack bot + Agent Core + notes + 手動 shelf.add + temperament骨格 | mention応答のみ | 応答品質、メモの取り方が自然か |
| P1: 睡眠と日記 | 2週 | 夜間バッチ、journal、忘却曲線、deep_recall、日報チャンネル投稿 | 日記投稿のみ | 翌日「昨日の件」が通じるか、日報が読まれるか |
| P2: 習慣 | 1週 | ビルトインルーティン3種、本棚Web UI | ルーティン投稿 | 朝の投稿が邪魔でないか |
| P3: 気づきと成長 | 2-3週 | Findingモデル、気づきモジュール、playbook、学習される習慣、channel_settings | dryrun並走→人間レビュー→live（§6.5） | dryrunのFinding精度、live後のうざさ ↔ 有能さ |

各フェーズで「人間らしく感じるか」をチーム内ドッグフーディングで評価。P3の気づきは proactivity を低め（0.3）から始めて週次で上げる。

---

## 14. 決定事項サマリと残課題

### 決定済み

1. コンセプトは「一人の同僚がそこにいる」。システム名は Ryo（僚）、個体はプリセットから派生し人間らしい個別名を持つ
2. 自発性・人格は temperament + channel_settings + プリセット（§8）でパラメータ化
3. 記憶は全公開 — 日記は個体ごとの日報チャンネル、本棚はWeb UI（§10.1）
4. 最初の実験場は実務チャンネル。自発性はフェーズで段階解禁（§13）
5. 個体間の記憶は共有しない。代わりに2個体ディスカッション機能をP4候補として設計（§8.4）
6. 外部能力はすべてEquipment（装備）に統一。装備 = MCPサーバー + スコープ + 危険度、個体へ支給し習熟度が育つ（§9）
7. Frank v2（実運用済みプロダクト）の実証パターンを採用：Findingモデル（§6.2）、完全性契約（§6.3）、off/dryrun/live 3モード（§6.5）、dispatcher方式（§5.1）、公開版設定（§6.1）、効果分類 + fail-closed + スコープ付き事前承認（§9・§12）
8. セルフイシュー機能（§6.4）：個体が自分の基盤の不具合を検知し、dedup・PII除外・件数上限つきで自リポジトリにIssueを自動起票する。人間からのFBもトリアージ（設定/記憶/基盤）→ 本人確認HITL → 構造化起票の経路でIssue化できる

### 残課題

1. 日記の機微情報ガードの精度 — 公開日報に書いてよい/悪いの線引きルール策定
2. evalの設計 — 「人間らしさ」の定量評価（記憶想起の正答率 + 主観アンケート）
3. プリセットの追加軸 — ムードメーカー等、業務価値が間接的なタイプを入れるか
4. ディスカッション機能の詳細 — ラリー上限の適正値、3体以上に拡張するか、人間の割り込み時の振る舞い
