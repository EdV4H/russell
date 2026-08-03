/**
 * event_log のマイグレーション（設計書 §3.1 / 19-data-model.md）。
 *
 * 起動時には流れない。適用するのは `pnpm migrate`（＝ `@edv4h/russell-migrate` のランナー）だけで、
 * プラグインの setup は「適用済みか」を確認するだけ（§11）。
 *
 * 追記専用を **DB 側で強制**する: UPDATE / DELETE / **TRUNCATE** をトリガで拒否する。
 * privacy-and-memory-policy の `"event_log": "append_only"` は運用規約ではなく制約として実装する。
 * TRUNCATE は行トリガを迂回するので、文トリガで明示的に塞ぐ（これが無いと全行消せてしまう）。
 * （retention は将来パーティション DROP で行う。行単位の削除は許さない。）
 *
 * ※ 適用済みの SQL は**書き換えない**（checksum で検出して止まる）。変更は新しい版を足す。
 */

import type { MigrationSet } from "@edv4h/russell-migrate";

export const AUDIT_MIGRATIONS: MigrationSet = {
  namespace: "audit-pg",
  migrations: [
    {
      id: "0001_event_log",
      phase: "expand",
      sql: `
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
  BEFORE UPDATE OR DELETE OR TRUNCATE ON event_log
  FOR EACH STATEMENT EXECUTE FUNCTION event_log_append_only();
`,
    },
  ],
};
