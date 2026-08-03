/**
 * 夜間コンソリデーション（§4）の結合テスト。要 DATABASE_URL。
 * 日記生成（冪等）・メモの consolidated 化・忘却曲線・書庫スイープを検証する。
 */

import { runConsolidation } from "@edv4h/russell-plugin-memory-pg";
import pg from "pg";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("consolidation（DATABASE_URL 必須）", () => {
  test("日記生成・メモ処理済み化・忘却曲線・書庫スイープ", async () => {
    const agentId = `worker-test-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    // スキーマは global-setup のマイグレーションで用意済み（テストは DDL を流さない, §11）
    await pool.query(
      "INSERT INTO notes (agent_id, context_id, content) VALUES ($1,'c1','出来事A'),($1,'c1','出来事B')",
      [agentId],
    );
    // 減衰しても残る本と、しきい値割れで書庫に落ちる本
    await pool.query(
      "INSERT INTO books (agent_id, title, card, strength) VALUES ($1,'高強度','A',1.0),($1,'低強度','B',0.20)",
      [agentId],
    );

    const now = new Date("2026-07-29T18:00:00Z");
    const r1 = await runConsolidation({ connectionString: DB, agentId, now });
    expect(r1.entryDate).toBe("2026-07-29");
    expect(r1.notesConsolidated).toBe(2);
    expect(r1.booksArchived).toBe(1); // 0.20 * e^-0.05 = 0.190… < 0.2 → 書庫へ

    // 日記が書かれた
    const journal = await pool.query<{ narrative: string }>(
      "SELECT narrative FROM journal_entries WHERE agent_id=$1 AND entry_date=$2",
      [agentId, "2026-07-29"],
    );
    expect(journal.rows[0]?.narrative).toContain("2件");

    // メモは consolidated 化済み → 2回目は 0 件（冪等・同日 UPSERT）
    const r2 = await runConsolidation({ connectionString: DB, agentId, now });
    expect(r2.notesConsolidated).toBe(0);
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM journal_entries WHERE agent_id=$1",
      [agentId],
    );
    expect(count.rows[0].n).toBe(1); // 同日エントリは1件のまま

    await pool.end();
  });
});
