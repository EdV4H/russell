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

describe.skipIf(!DB)("本棚の整理（§4-3, DATABASE_URL 必須）", () => {
  /** 本棚を用意して整理を1回走らせる。 */
  async function withShelf(modelOutput: string, opts: { dryRun?: boolean } = {}) {
    const agentId = `organize-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query(
      `INSERT INTO books (agent_id, title, card, strength) VALUES
         ($1,'役割の期待','広く浅く答えて詳しい人へ繋ぐハブ役',0.6),
         ($1,'丸山さんは私に「広く浅','ハブ役を期待。主要ツールは Slack と Notion',0.9)`,
      [agentId],
    );
    const ids = await pool.query<{ id: string }>(
      "SELECT id FROM books WHERE agent_id=$1 ORDER BY id",
      [agentId],
    );
    const [a, b] = ids.rows.map((r) => Number(r.id));
    const audited: { action: string; payload: Record<string, unknown> }[] = [];

    const result = await runConsolidation({
      connectionString: DB,
      agentId,
      now: new Date("2026-07-29T18:00:00Z"),
      dryRun: opts.dryRun,
      organize: async () => modelOutput.replaceAll("<A>", String(a)).replaceAll("<B>", String(b)),
      audit: async (e) => {
        audited.push(e);
      },
    });

    const books = await pool.query<{
      id: string;
      title: string;
      card: string;
      status: string;
      strength: number;
    }>("SELECT id, title, card, status, strength FROM books WHERE agent_id=$1 ORDER BY id", [
      agentId,
    ]);
    await pool.end();
    return { result, audited, a, b, rows: books.rows.map((r) => ({ ...r, id: Number(r.id) })) };
  }

  test("重複を1冊に畳み、畳まれた方は消さずに書庫へ下げる", async () => {
    const { result, rows, a, b } = await withShelf(
      '{"merges":[{"keep":<A>,"absorb":[<B>],"title":"期待される役割と主要ツール","card":"広く浅く答えて詳しい人へ繋ぐハブ役。主要ツールは Slack と Notion。"}],"retitles":[]}',
    );

    expect(result.booksMerged).toBe(1);
    expect(result.booksAbsorbed).toBe(1);

    const keep = rows.find((r) => r.id === a);
    expect(keep?.title).toBe("期待される役割と主要ツール");
    expect(keep?.card).toContain("Slack と Notion"); // 片方にしか無かった具体が残っている
    // まとめたことで弱くならない（組の最大を引き継ぐ）。忘却の減衰は後段で1回かかる。
    expect(keep?.strength).toBeCloseTo(0.9 * Math.exp(-0.05), 5);

    // **消えていない。** 書庫にあるので後から辿れる（可逆, L1）
    const absorbed = rows.find((r) => r.id === b);
    expect(absorbed).toBeDefined();
    expect(absorbed?.status).toBe("archived");

    // 残した側の元の文章も書庫に控えがある。整理を部分的にも不可逆にしない
    const snapshot = rows.find((r) => r.status === "archived" && r.title === "役割の期待");
    expect(snapshot?.card).toBe("広く浅く答えて詳しい人へ繋ぐハブ役");
  });

  test("見出しだけを付け直す", async () => {
    const { result, rows, b } = await withShelf(
      '{"merges":[],"retitles":[{"id":<B>,"title":"期待される役割"}]}',
    );

    expect(result.booksRetitled).toBe(1);
    const retitled = rows.find((r) => r.id === b);
    expect(retitled?.title).toBe("期待される役割");
    expect(retitled?.card).toContain("ハブ役を期待"); // 本文は変えない
    expect(retitled?.status).toBe("active");
  });

  test("--dry-run は計画を返すだけで本棚を変えない", async () => {
    const { result, rows, audited, a } = await withShelf(
      '{"merges":[{"keep":<A>,"absorb":[<B>],"title":"新しい見出し","card":"まとめた内容"}],"retitles":[]}',
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.plan.merges).toHaveLength(1); // 何をするつもりかは見える
    expect(result.booksMerged).toBe(0);
    expect(rows.find((r) => r.id === a)?.title).toBe("役割の期待"); // 変わっていない
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(audited).toEqual([]); // 何もしていないので監査にも残さない
    // 見積りは返す（やったら2冊とも減衰する）
    expect(result.booksDecayed).toBe(2);
  });

  test("--dry-run は本棚以外にも書き込まない（日記・忘却を含めて何も変えない）", async () => {
    const agentId = `dryrun-all-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query(
      "INSERT INTO notes (agent_id, context_id, content) VALUES ($1,'c1','出来事A')",
      [agentId],
    );
    await pool.query(
      "INSERT INTO books (agent_id, title, card, strength) VALUES ($1,'A','a',0.21)",
      [agentId],
    );

    const result = await runConsolidation({
      connectionString: DB,
      agentId,
      now: new Date("2026-07-29T18:00:00Z"),
      dryRun: true,
    });

    // 「やったらどうなるか」は返る
    expect(result.notesConsolidated).toBe(1);
    expect(result.booksArchived).toBe(1); // 0.21 * e^-0.05 = 0.199… < 0.2

    // …が、DB は1行も変わっていない
    const journal = await pool.query("SELECT 1 FROM journal_entries WHERE agent_id=$1", [agentId]);
    expect(journal.rowCount).toBe(0);
    const note = await pool.query<{ consolidated: boolean }>(
      "SELECT consolidated FROM notes WHERE agent_id=$1",
      [agentId],
    );
    expect(note.rows[0]?.consolidated).toBe(false);
    const book = await pool.query<{ strength: number; status: string }>(
      "SELECT strength, status FROM books WHERE agent_id=$1",
      [agentId],
    );
    expect(book.rows[0]?.strength).toBeCloseTo(0.21, 5);
    expect(book.rows[0]?.status).toBe("active");

    await pool.end();
  });

  test("整理は監査に残る。ただし本文は残さない（A1-5）", async () => {
    const { audited, a, b } = await withShelf(
      '{"merges":[{"keep":<A>,"absorb":[<B>],"title":"見出し","card":"本文はここにある"}],"retitles":[]}',
    );

    expect(audited).toHaveLength(1);
    expect(audited[0]?.action).toBe("memory.shelf.organized");
    expect(audited[0]?.payload).toMatchObject({ merges: [{ keep: a, absorbed: [b] }] });
    // どの本がどこへ行ったかは id で辿れる。中身は記憶側にしか無い
    expect(JSON.stringify(audited[0]?.payload)).not.toContain("本文はここにある");
  });

  test("モデルの出力が壊れていても夜間バッチは通る", async () => {
    const { result, rows } = await withShelf("整理できませんでした");

    expect(result.booksMerged).toBe(0);
    expect(result.notesConsolidated).toBe(0);
    expect(result.entryDate).toBe("2026-07-29"); // 日記は書かれている
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  test("モデルを渡さなければ整理しない（決定論的な処理だけ動く）", async () => {
    const agentId = `organize-none-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query(
      "INSERT INTO books (agent_id, title, card, strength) VALUES ($1,'A','a',1.0),($1,'B','b',1.0)",
      [agentId],
    );
    const result = await runConsolidation({ connectionString: DB, agentId });
    expect(result.booksMerged).toBe(0);
    expect(result.plan.merges).toEqual([]);
    expect(result.booksDecayed).toBe(2); // 忘却は動く
    await pool.end();
  });
});

describe.skipIf(!DB)("メモから本棚への昇格（§4-3, DATABASE_URL 必須）", () => {
  async function withNotes(modelOutput: string, count = 3, opts: { dryRun?: boolean } = {}) {
    const agentId = `promote-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pool = new pg.Pool({ connectionString: DB });
    for (let i = 0; i < count; i++) {
      await pool.query("INSERT INTO notes (agent_id, context_id, content) VALUES ($1,'c1',$2)", [
        agentId,
        `メモ${i + 1}`,
      ]);
    }
    const ids = await pool.query<{ id: string }>(
      "SELECT id FROM notes WHERE agent_id=$1 ORDER BY id",
      [agentId],
    );
    const noteIds = ids.rows.map((r) => Number(r.id));
    const audited: { action: string; payload: Record<string, unknown> }[] = [];

    const result = await runConsolidation({
      connectionString: DB,
      agentId,
      now: new Date("2026-07-29T18:00:00Z"),
      dryRun: opts.dryRun,
      // 昇格の判定と整理の判定に同じモデルが使われる。整理側は本が1冊しか無ければ呼ばれない。
      organize: async () => modelOutput.replaceAll("<IDS>", JSON.stringify(noteIds)),
      audit: async (e) => {
        audited.push(e);
      },
    });

    const books = await pool.query<{
      title: string;
      card: string;
      origin: string;
      source_note_ids: string[];
    }>("SELECT title, card, origin, source_note_ids FROM books WHERE agent_id=$1", [agentId]);
    const notes = await pool.query<{ id: string; promoted_at: Date | null }>(
      "SELECT id, promoted_at FROM notes WHERE agent_id=$1 ORDER BY id",
      [agentId],
    );
    await pool.end();
    return { result, audited, noteIds, books: books.rows, notes: notes.rows };
  }

  const PROMOTION =
    '{"promotions":[{"note_ids":<IDS>,"title":"期待される役割","card":"複数のメモから見えてきたこと"}]}';

  test("3件のメモが1冊の本になり、来歴が残る", async () => {
    const { result, books, notes, noteIds } = await withNotes(PROMOTION);

    expect(result.booksPromoted).toBe(1);
    expect(result.notesPromoted).toBe(3);
    expect(books[0]?.title).toBe("期待される役割");
    // 本棚から会話へ遡れる
    expect(books[0]?.origin).toBe("promoted");
    expect(books[0]?.source_note_ids?.map(Number)).toEqual(noteIds);
    // 昇格済みの印が付く（翌晩また同じ本が生まれない）
    expect(notes.every((n) => n.promoted_at !== null)).toBe(true);
  });

  test("同じメモは二度昇格しない", async () => {
    const agentId = `promote-once-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    for (let i = 0; i < 3; i++) {
      await pool.query("INSERT INTO notes (agent_id, context_id, content) VALUES ($1,'c1',$2)", [
        agentId,
        `メモ${i}`,
      ]);
    }
    const ids = await pool.query<{ id: string }>("SELECT id FROM notes WHERE agent_id=$1", [
      agentId,
    ]);
    const noteIds = ids.rows.map((r) => Number(r.id));
    const organize = async () =>
      `{"promotions":[{"note_ids":${JSON.stringify(noteIds)},"title":"T","card":"C"}],"merges":[],"retitles":[]}`;

    const first = await runConsolidation({ connectionString: DB, agentId, organize });
    const second = await runConsolidation({ connectionString: DB, agentId, organize });

    expect(first.booksPromoted).toBe(1);
    expect(second.booksPromoted).toBe(0); // 候補が残っていない
    const books = await pool.query("SELECT 1 FROM books WHERE agent_id=$1", [agentId]);
    expect(books.rowCount).toBe(1);
    await pool.end();
  });

  test("メモが3件未満ならモデルを呼ばずに何もしない", async () => {
    let called = false;
    const agentId = `promote-few-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query(
      "INSERT INTO notes (agent_id, context_id, content) VALUES ($1,'c1','ひとつ')",
      [agentId],
    );

    const result = await runConsolidation({
      connectionString: DB,
      agentId,
      organize: async () => {
        called = true;
        return "{}";
      },
    });

    expect(result.booksPromoted).toBe(0);
    expect(called).toBe(false); // 呼んでも昇格しないので呼ばない
    await pool.end();
  });

  test("--dry-run は昇格も適用しない", async () => {
    const { result, books, notes } = await withNotes(PROMOTION, 3, { dryRun: true });

    expect(result.promotions).toHaveLength(1); // 何をするつもりかは見える
    expect(result.booksPromoted).toBe(0);
    expect(books).toEqual([]);
    expect(notes.every((n) => n.promoted_at === null)).toBe(true);
  });

  test("昇格は監査に残る。本文は残さない（A1-5）", async () => {
    const { audited, noteIds } = await withNotes(PROMOTION);

    const promoted = audited.find((e) => e.action === "memory.books.promoted");
    expect(promoted?.payload).toMatchObject({ books: 1, notes: noteIds });
    expect(JSON.stringify(promoted?.payload)).not.toContain("複数のメモから見えてきたこと");
  });
});
