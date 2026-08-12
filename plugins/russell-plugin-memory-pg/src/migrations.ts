/**
 * 記憶テーブルのマイグレーション（P0 の最小スキーマ。設計書 §3.1 の部分集合）。
 * ベクトル列は用意するが P0 では埋め込みを入れない（recall は recency ベース、deep_recall は本文一致）。
 *
 * 起動時には流れない。適用するのは `pnpm migrate` だけ（§11）。
 * ※ 適用済みの SQL は**書き換えない**（checksum で検出して止まる）。変更は新しい版を足す。
 */

import type { MigrationSet } from "@edv4h/russell-migrate";

export const MEMORY_MIGRATIONS: MigrationSet = {
  namespace: "memory-pg",
  migrations: [
    {
      id: "0001_notes_books_journal",
      phase: "expand",
      sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  consolidated BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS notes_agent_context_idx ON notes (agent_id, context_id);

-- 日記（夜間バッチが書く。1日1エントリ、日付キーで冪等）§4
CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_date DATE NOT NULL,
  narrative TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entry_date)
);

CREATE TABLE IF NOT EXISTS books (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  card TEXT NOT NULL,
  shelf TEXT NOT NULL DEFAULT 'general',
  strength REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding vector(1024)
);
CREATE INDEX IF NOT EXISTS books_agent_status_idx ON books (agent_id, status);
`,
    },
    {
      // 本を「昇格」で作れるようにする（§4-3 / ADR 0005）。
      // 会話中に直接書くのをやめ、複数のメモから夜間バッチが1冊を書く形に移る。
      id: "0002_book_promotion",
      phase: "expand",
      sql: `
-- どのメモから昇格したか。冪等性（同じメモを二度昇格させない）にも使う
ALTER TABLE notes ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS notes_agent_promoted_idx ON notes (agent_id, promoted_at);

-- この本がどうやってできたか。'conversation'（会話中に直接）/ 'promoted'（メモからの昇格）
ALTER TABLE books ADD COLUMN IF NOT EXISTS origin TEXT;
-- 昇格元のメモ。本棚から会話へ遡れるようにする
ALTER TABLE books ADD COLUMN IF NOT EXISTS source_note_ids BIGINT[];
`,
    },
    {
      // 既存の本はすべて会話中に直接書かれたもの。既定を入れて由来を辿れるようにする。
      // expand で NULL 許容にしてあるので、旧コードが動いたままでも壊れない（§11）。
      id: "0003_backfill_book_origin",
      phase: "backfill",
      sql: `
UPDATE books SET origin = 'conversation' WHERE origin IS NULL;
`,
    },
    {
      // 機微情報の印（A-1 / ADR 0007）。記憶からは落とさず、公開経路に出さないための列。
      id: "0004_sensitive_marks",
      phase: "expand",
      sql: `
-- 当たった DO-NOT-WRITE カテゴリ。空配列ではなく NULL = 未検査（既存行と区別する）
ALTER TABLE notes ADD COLUMN IF NOT EXISTS sensitive_categories TEXT[];
ALTER TABLE books ADD COLUMN IF NOT EXISTS sensitive_categories TEXT[];
CREATE INDEX IF NOT EXISTS notes_sensitive_idx ON notes USING GIN (sensitive_categories);
`,
    },
    {
      // 索引カード（設計書 §3.1 の entities）。単語帳＝type='term'、個人カルテ＝type='person'。
      // **本棚とは忘却の意味が違う**ので分ける（使わなくても定義は忘れない, ADR 0008）。
      id: "0005_entities",
      phase: "expand",
      sql: `
CREATE TABLE IF NOT EXISTS entities (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  -- 表記ゆれ・略称・呼び名。**一致で引く**ので構造で持つ（本文に書くと部分一致で誤爆する）
  aliases TEXT[] NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  sensitive_categories TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding vector(1024)
);
-- 同じ語は1件で、更新される（本棚のように積み上がって夜に畳む、ではない）
CREATE UNIQUE INDEX IF NOT EXISTS entities_agent_type_name_idx
  ON entities (agent_id, type, lower(name));
CREATE INDEX IF NOT EXISTS entities_aliases_idx ON entities USING GIN (aliases);
`,
    },
    {
      /*
       * 引き受けた作業（ADR 0009）。
       *
       * **メモ帳にも索引カードにも乗らない。** メモは TTL 7日で消えるので「来週やる」が
       * 消える。索引カードは状態を持たない構造で、作業は状態と持ち主を持つ。
       *
       * 忘却曲線は適用しない。**引き受けたことを時間で忘れてはいけない**。代わりに
       * 「何日動いていないか」が見えるようにする（`updated_at`）。
       */
      id: "0006_todos",
      phase: "expand",
      sql: `
CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  -- open=自分が動く / waiting=相手の返事待ち / done=終わった / dropped=やらないと決めた
  -- **dropped を消さずに残す**のは、やらないと決めた判断も記録だから（記憶の扱いと同じ）
  state TEXT NOT NULL DEFAULT 'open',
  -- どの会話で引き受けたか。想起の絞り込みと、後から経緯を辿るために持つ
  context_id TEXT,
  -- 誰の返事を待っているか（waiting のとき）。人物カルテとは別に、素の表記で持つ
  waiting_for TEXT,
  sensitive_categories TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS todos_agent_state_idx ON todos (agent_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS todos_agent_context_idx ON todos (agent_id, context_id);
`,
    },
  ],
};
