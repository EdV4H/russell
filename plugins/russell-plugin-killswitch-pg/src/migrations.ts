/**
 * キルスイッチ（通常経路）のマイグレーション。設計書 §12-4 / 19-data-model.md。
 *
 * 起動時には流れない。適用するのは `pnpm migrate` だけ（§11）。
 *
 * 現在の状態だけを持つ。「誰がいつ何のために発動/解除したか」の履歴は `event_log`
 * （`killswitch.engaged` / `killswitch.released`）にあるので、ここで二重に持たない。
 *
 * ※ 適用済みの SQL は書き換えない（checksum で検出して止まる）。変更は新しい版を足す。
 */

import type { MigrationSet } from "@edv4h/russell-migrate";

export const KILLSWITCH_MIGRATIONS: MigrationSet = {
  namespace: "killswitch-pg",
  migrations: [
    {
      id: "0001_agent_stops",
      phase: "expand",
      sql: `
CREATE TABLE IF NOT EXISTS agent_stops (
  target TEXT PRIMARY KEY,                          -- 個体 id、または '*'（全体停止）
  stopped BOOLEAN NOT NULL,
  by_actor TEXT NOT NULL,                           -- 発動/解除した人（Slack user id 等）
  reason TEXT,                                      -- 運用記録。監査 payload には入れない（A1-5）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    },
  ],
};

/** 全体停止（`--all`）を表す行のキー。個体 id には使えない文字なので衝突しない。 */
export const ALL_TARGET = "*";
