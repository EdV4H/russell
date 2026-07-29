/**
 * 夜間コンソリデーション（§4 睡眠コンソリデーション / MAGMA Slow Path）の核。
 * P1 の入口として、日記生成・忘却曲線・書庫スイープの最小実装を提供する。
 *
 * 冪等（§4「日付キーで再実行可能」）: journal は (agent_id, entry_date) の UPSERT。
 * 日記の物語は P1 フルではモデル（Haiku）で書くが、ここでは決定論的な要約で足場を作る。
 */

import pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

export interface ConsolidationOptions {
  connectionString?: string;
  agentId: string;
  /** 基準日時（テスト用に注入可能）。既定は現在時刻。 */
  now?: Date;
  /** 忘却率 λ（§3.4, 既定 0.05）。 */
  lambda?: number;
  /** dev/test 用スキーマ自動作成。 */
  autoMigrate?: boolean;
}

export interface ConsolidationResult {
  entryDate: string;
  narrative: string;
  notesConsolidated: number;
  booksDecayed: number;
  booksArchived: number;
}

/** 1回のコンソリデーションを実行する（worker から呼ぶ）。 */
export async function runConsolidation(
  options: ConsolidationOptions,
): Promise<ConsolidationResult> {
  const { agentId } = options;
  const now = options.now ?? new Date();
  const lambda = options.lambda ?? 0.05;
  const entryDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const pool = new pg.Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
  });
  try {
    if (options.autoMigrate) await pool.query(SCHEMA_SQL);

    // 1. 未処理メモを集める（§4-1）
    const notes = await pool.query<{ id: string; content: string }>(
      "SELECT id, content FROM notes WHERE agent_id = $1 AND consolidated = false ORDER BY created_at ASC",
      [agentId],
    );

    // 2. 日記を書く（P1 フルはモデルで narrative。ここは決定論的要約）
    const events = notes.rows.map((r) => ({ summary: r.content }));
    const narrative =
      notes.rows.length === 0
        ? `${entryDate}: 記録すべき出来事はなかった。`
        : `${entryDate}: ${notes.rows.length}件の記録。${notes.rows.map((r) => r.content).join(" / ")}`;

    await pool.query(
      `INSERT INTO journal_entries (agent_id, entry_date, narrative, events)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (agent_id, entry_date)
       DO UPDATE SET narrative = EXCLUDED.narrative, events = EXCLUDED.events`,
      [agentId, entryDate, narrative, JSON.stringify(events)],
    );

    // 3. 処理済みメモに印を付ける
    const consolidated = await pool.query(
      "UPDATE notes SET consolidated = true WHERE agent_id = $1 AND consolidated = false",
      [agentId],
    );

    // 4. 忘却の適用（§3.4）: 減衰 → strength<0.2 を書庫へ
    const decayed = await pool.query(
      "UPDATE books SET strength = strength * exp(-$2::double precision) WHERE agent_id = $1 AND status = 'active'",
      [agentId, lambda],
    );
    const archived = await pool.query(
      "UPDATE books SET status = 'archived' WHERE agent_id = $1 AND status = 'active' AND strength < 0.2",
      [agentId],
    );

    return {
      entryDate,
      narrative,
      notesConsolidated: consolidated.rowCount ?? 0,
      booksDecayed: decayed.rowCount ?? 0,
      booksArchived: archived.rowCount ?? 0,
    };
  } finally {
    await pool.end();
  }
}
