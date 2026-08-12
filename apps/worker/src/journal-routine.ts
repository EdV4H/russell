/**
 * 日報のルーティン（dispatcher から呼ばれる）。
 *
 * **手で流すときと同じ経路を通る**（`journal-runner`）。別々に組むと
 * 「手動では動くが自動実行では設定が違う」という差が生まれる。
 */

import type { RunStatus } from "@edv4h/russell-core";
import pg from "pg";
import { createJournalRunner } from "./journal-runner.js";

export async function runJournalRoutine(
  scheduledFor: Date,
): Promise<{ status: RunStatus; detail?: string }> {
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (err) => console.error("[journal] Postgres 接続エラー:", err.message));
  try {
    const runner = await createJournalRunner(pool, agentId);
    // **予定時刻の前日分**を書く。03:00 に走るのは「昨日1日」をまとめるため。
    const target = new Date(scheduledFor.getTime() - 12 * 60 * 60 * 1000);
    const result = await runner.consolidate(target);
    const status = await runner.publish({
      entryDate: result.entryDate,
      narrative: result.narrative,
      events: result.notesConsolidated - result.notesWithheld,
    });
    return { status, detail: `${result.entryDate}` };
  } finally {
    await pool.end();
  }
}
