/**
 * P0 の最小スキーマ（notes / books）。設計書 §3.1 の部分集合。
 * ベクトル列は用意するが P0 では埋め込みを入れない（recall は recency ベース、deep_recall は本文一致）。
 *
 * ※ 本番は「起動時 CREATE TABLE をしない」（§11）。マイグレーションツールで
 *   expand→backfill→contract する。この SQL は dev/test の autoMigrate 用の叩き台。
 */
export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notes_agent_context_idx ON notes (agent_id, context_id);

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
`;
