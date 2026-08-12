/**
 * 設定の読み書き（プールを渡す形）。
 *
 * worker のようにコアの外にいるプロセスからも読めるようにするため、
 * プラグインとは別に関数として出してある。
 */

import type pg from "pg";

/** 日報の投稿先チャンネル。**未設定なら投稿しない**（既定でどこかへ流し始めない）。 */
export const JOURNAL_CHANNEL_KEY = "journal.channel";

export async function readSetting(
  pool: pg.Pool,
  agentId: string,
  key: string,
): Promise<string | undefined> {
  const res = await pool.query<{ value: string | null }>(
    "SELECT value FROM agent_settings WHERE agent_id = $1 AND key = $2",
    [agentId, key],
  );
  return res.rows[0]?.value ?? undefined;
}

export async function writeSetting(
  pool: pg.Pool,
  agentId: string,
  key: string,
  value: string | null,
  updatedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_settings (agent_id, key, value, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [agentId, key, value, updatedBy],
  );
}
