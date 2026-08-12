/**
 * 設定の読み書き（プールを渡す形）。
 *
 * worker のようにコアの外にいるプロセスからも読めるようにするため、
 * プラグインとは別に関数として出してある。
 */

import type pg from "pg";

/** 日報の投稿先チャンネル。**未設定なら投稿しない**（既定でどこかへ流し始めない）。 */
export const JOURNAL_CHANNEL_KEY = "journal.channel";

/** 全個体の既定を表す agent_id（キルスイッチの `target='*'` と同じ形）。 */
export const ALL_AGENTS = "*";

/**
 * その個体の設定を読む。**自分の設定が無ければ全個体の既定へ落ちる。**
 *
 * 個体ごとに別アプリだと2体目は `/russell` を持てない（Slack のスラッシュコマンドは
 * 1ワークスペースに1アプリ）。`--all` で書いた既定を全員が読めるようにしておく必要がある。
 */
export async function readSettingWithDefault(
  pool: pg.Pool,
  agentId: string,
  key: string,
): Promise<string | undefined> {
  return (await readSetting(pool, agentId, key)) ?? (await readSetting(pool, ALL_AGENTS, key));
}

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
