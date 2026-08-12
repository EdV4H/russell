import type { MigrationSet } from "@edv4h/russell-migrate";

export const ROUTINES_MIGRATIONS: MigrationSet = {
  namespace: "routines-pg",
  migrations: [
    {
      /*
       * ルーティンの台帳と実行記録（§5.1 dispatcher 方式）。
       *
       * 静的 cron を直接実行しないのは、**止まっていた間の予定をどう扱うか**を
       * cron 自身が決められないため。台帳に持って dispatcher が claim する形にする。
       */
      id: "0001_routines",
      phase: "expand",
      sql: `
CREATE TABLE IF NOT EXISTS routines (
  agent_id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  -- skip / coalesce / replay_once（§5.1）。既定 coalesce＝復旧直後に連投しない
  catchup TEXT NOT NULL DEFAULT 'coalesce',
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- 学習された習慣か（§5「勝手に習慣を作らない」——origin で出自を残す）
  origin TEXT NOT NULL DEFAULT 'builtin',
  last_scheduled_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, routine_id)
);

CREATE TABLE IF NOT EXISTS routine_runs (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  -- **論理実行は1件**。同じ予定時刻を二度走らせない（§5.1）
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  -- リースの生存確認。実行中のプロセスが落ちたら別のプロセスが引き取れる
  heartbeat_at TIMESTAMPTZ,
  -- 引き取りのたびに増える。古い書き手の更新を弾く（fencing token）
  fence BIGINT NOT NULL DEFAULT 1,
  detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (agent_id, routine_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS routine_runs_open_idx
  ON routine_runs (agent_id, status, heartbeat_at);
`,
    },
  ],
};
