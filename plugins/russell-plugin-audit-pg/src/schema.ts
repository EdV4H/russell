/**
 * event_log のスキーマ（設計書 §3.1 / 19-data-model.md）。
 *
 * 追記専用を **DB 側で強制**する: UPDATE/DELETE はトリガで拒否する。
 * privacy-and-memory-policy の `"event_log": "append_only"` は運用規約ではなく制約として実装する。
 * （retention は将来パーティション DROP で行う。行単位の削除は許さない。）
 *
 * ※ 本番は「起動時 CREATE TABLE をしない」（§11）。この SQL は dev/test の autoMigrate 用。
 *   expand→backfill→contract のマイグレーションツール導入は別 PR（横断ゲート2）。
 */
export const AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id TEXT NOT NULL,
  config_version TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  trust_label TEXT NOT NULL CHECK (trust_label IN ('trusted', 'untrusted'))
);
CREATE INDEX IF NOT EXISTS event_log_agent_ts_idx ON event_log (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS event_log_action_idx ON event_log (action);

-- 追記専用の強制（§3.1「追記専用」/ privacy-and-memory-policy）
CREATE OR REPLACE FUNCTION event_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event_log is append-only (§3.1)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_no_mutate ON event_log;
CREATE TRIGGER event_log_no_mutate
  BEFORE UPDATE OR DELETE ON event_log
  FOR EACH STATEMENT EXECUTE FUNCTION event_log_append_only();
`;
