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
    {
      /*
       * 退避のための穴を1つだけ開ける（#26）。
       *
       * 方針は「**監査ログは削除しない**」（privacy-and-memory-policy）。しかし retention が
       * 無いと単調に増え、埋まると次の連鎖が起きる:
       *   event_log に書けない → 監査 degraded → Policy Gate が read 以外を deny（fail-closed）
       *   → 応答も記憶書き込みも止まる
       * **唯一増え続けるテーブルで、自分で削除経路を塞いでいる**ため、埋まると回避手段が無い。
       *
       * 解決は「消す」ではなく「**外へ出してから、ライブのテーブルから外す**」。
       * そのため DELETE を**セッション変数が立っているときだけ**通す。
       * 誤って消せないことは変わらず、退避という明示的な操作だけが通る。
       *
       * UPDATE と TRUNCATE は**引き続き常に拒否**する。書き換えと一括消去に正当な用途は無い。
       */
      id: "0002_allow_archive_delete",
      phase: "expand",
      sql: `
CREATE OR REPLACE FUNCTION event_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('russell.archive', true) = 'on' THEN
    RETURN NULL; -- 退避中（BEFORE ... FOR EACH STATEMENT なので NULL でも削除は進む）
  END IF;
  RAISE EXCEPTION 'event_log is append-only (§3.1)';
END;
$$ LANGUAGE plpgsql;
`,
    },
    {
      /*
       * 死活（#78）。**監査と同じ関心**——何が起きているかを外から見るためのもの。
       *
       * event_log に heartbeat を積まない。5分ごとに1行入れると1日288行になり、
       * #26 で片付けた「増え続ける」問題を自分で作り直すことになる。
       * **1コンポーネント1行を上書き**する形にして、行が増えないようにする。
       */
      id: "0003_heartbeats",
      phase: "expand",
      sql: `
CREATE TABLE IF NOT EXISTS component_heartbeats (
  agent_id TEXT NOT NULL,
  -- 'agent'（Slack の常駐）/ 'dispatcher'（定期実行）
  component TEXT NOT NULL,
  beat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 途絶えたことを通知済みか。**毎 tick 通知しない**ための状態
  alerted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (agent_id, component)
);
`,
    },
  ],
};
