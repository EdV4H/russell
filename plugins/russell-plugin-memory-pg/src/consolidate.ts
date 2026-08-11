/**
 * 夜間コンソリデーション（§4 睡眠コンソリデーション / MAGMA Slow Path）の核。
 * P1 の入口として、日記生成・忘却曲線・書庫スイープの最小実装を提供する。
 *
 * 冪等（§4「日付キーで再実行可能」）: journal は (agent_id, entry_date) の UPSERT。
 * 日記の物語は P1 フルではモデル（Haiku）で書くが、ここでは決定論的な要約で足場を作る。
 */

import { assertAutoMigrateAllowed, assertSchemaReady, runMigrations } from "@edv4h/russell-migrate";
import pg from "pg";
import { MEMORY_MIGRATIONS } from "./migrations.js";
import {
  EMPTY_PLAN,
  type OrganizePlan,
  type ShelfBook,
  buildOrganizePrompt,
  isEmptyPlan,
  parseOrganizePlan,
  validatePlan,
} from "./organize.js";
import {
  MIN_NOTES_FOR_PROMOTION,
  type PromotableNote,
  type PromotionPlan,
  buildPromotionPrompt,
  parsePromotions,
  validatePromotions,
} from "./promote.js";

export interface ConsolidationOptions {
  connectionString?: string;
  agentId: string;
  /** 基準日時（テスト用に注入可能）。既定は現在時刻。 */
  now?: Date;
  /** 忘却率 λ（§3.4, 既定 0.05）。 */
  lambda?: number;
  /** dev/test 用に起動時マイグレーションを走らせる。本番（NODE_ENV=production）では拒否される（§11）。 */
  autoMigrate?: boolean;
  /**
   * 本棚の編集に使うモデル（§4-3）。**渡さなければ昇格も整理もしない。**
   * 決定論的な処理（日記・忘却）はモデル無しでも動く必要があるので、任意にしてある。
   */
  organize?: (req: { system: string; user: string }) => Promise<string>;
  /** 昇格の材料にするメモの期間（日数）。既定7日（§4-3「週内に」）。 */
  promotionWindowDays?: number;
  /**
   * **何も書き込まない。** 日記も忘却も含めて DB は一切変えず、「やったらどうなるか」だけを返す。
   *
   * 整理だけを除外する形にしていないのは、`--dry-run` が一部だけ書き込む挙動は罠だから。
   */
  dryRun?: boolean;
  /**
   * 整理の結果を監査へ残す。**本文は渡さない**（id と件数だけ, A1-5）。
   * worker はコアの外にいて AuditRegistry を持たないので、注入で受ける。
   */
  audit?: (event: { action: string; payload: Record<string, unknown> }) => Promise<void>;
}

export interface ConsolidationResult {
  entryDate: string;
  narrative: string;
  notesConsolidated: number;
  booksDecayed: number;
  booksArchived: number;
  /** メモから昇格した本の冊数。 */
  booksPromoted: number;
  /** 昇格に使ったメモの件数。 */
  notesPromoted: number;
  /** 実際に適用した（dryRun なら適用しなかった）昇格の計画。 */
  promotions: PromotionPlan[];
  /** 整理で畳んだ本の組数。 */
  booksMerged: number;
  /** 畳まれて書庫へ下がった本の冊数。 */
  booksAbsorbed: number;
  /** 見出しを付け直した冊数。 */
  booksRetitled: number;
  /** 実際に適用した（dryRun なら適用しなかった）計画。 */
  plan: OrganizePlan;
  /** 何も書き込んでいない。数字は「やったらどうなるか」の見積り。 */
  dryRun: boolean;
  /** 機微情報の印が付いていて日記に載せなかったメモの件数（A-1）。 */
  notesWithheld: number;
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
  // idle 接続のエラーでバッチごと落とさない。失敗するなら実行中のクエリで失敗させる。
  pool.on("error", (err) => {
    console.error("[memory-pg] Postgres 接続エラー（プールが再接続します）:", err.message);
  });
  try {
    if (options.autoMigrate) {
      assertAutoMigrateAllowed(MEMORY_MIGRATIONS.namespace);
      await runMigrations(pool, [MEMORY_MIGRATIONS]);
    } else {
      await assertSchemaReady(pool, [MEMORY_MIGRATIONS]);
    }

    // 1. 未処理メモを集める（§4-1）
    const notes = await pool.query<{
      id: string;
      content: string;
      sensitive_categories: string[] | null;
    }>(
      `SELECT id, content, sensitive_categories FROM notes
        WHERE agent_id = $1 AND consolidated = false ORDER BY created_at ASC`,
      [agentId],
    );

    // 2. 日記を書く（P1 フルはモデルで narrative。ここは決定論的要約）
    //
    // **機微情報の印が付いたメモは日記に載せない**（A-1 / ADR 0007）。日記は毎朝
    // #<個体名>-日報 へ投稿される＝ここが公開の境界。記憶からは落とさないので、
    // 会話の中では引き続き使える（知っているが公開しない）。
    const publishable = notes.rows.filter((r) => (r.sensitive_categories ?? []).length === 0);
    const withheld = notes.rows.length - publishable.length;
    const events = publishable.map((r) => ({ summary: r.content }));
    const narrative =
      publishable.length === 0
        ? `${entryDate}: 記録すべき出来事はなかった。`
        : `${entryDate}: ${publishable.length}件の記録。${publishable.map((r) => r.content).join(" / ")}`;

    const dryRun = options.dryRun ?? false;

    if (!dryRun) {
      await pool.query(
        `INSERT INTO journal_entries (agent_id, entry_date, narrative, events)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (agent_id, entry_date)
         DO UPDATE SET narrative = EXCLUDED.narrative, events = EXCLUDED.events`,
        [agentId, entryDate, narrative, JSON.stringify(events)],
      );

      // 3. 処理済みメモに印を付ける
      await pool.query(
        "UPDATE notes SET consolidated = true WHERE agent_id = $1 AND consolidated = false",
        [agentId],
      );
    }

    // 3-a. 本棚への昇格（§4-3）: 繰り返し現れる話題を1冊にする。モデルが無ければ何もしない。
    // **整理より先に行う。** 昇格した本も同じ夜のうちに重複判定へ回す。
    const promotions = options.organize
      ? await planPromotions(pool, agentId, options.organize, options.promotionWindowDays ?? 7)
      : [];
    const promoted =
      (options.dryRun ?? false) || promotions.length === 0
        ? { books: 0, notes: 0 }
        : await applyPromotions(pool, agentId, promotions);

    // 3-b. 本棚の編集（§4-3）: 重複を畳み、見出しを付け直す。モデルが無ければ何もしない。
    const plan = options.organize
      ? await organizeShelf(pool, agentId, options.organize)
      : EMPTY_PLAN;
    const applied =
      dryRun || isEmptyPlan(plan)
        ? { merged: 0, absorbed: 0, retitled: 0 }
        : await applyPlan(pool, agentId, plan);
    if (!dryRun && options.audit && withheld > 0) {
      await options.audit({
        action: "journal.withheld",
        payload: {
          notes: withheld,
          categories: [...new Set(notes.rows.flatMap((r) => r.sensitive_categories ?? []))],
        },
      });
    }
    if (!dryRun && options.audit && promoted.books > 0) {
      await options.audit({
        action: "memory.books.promoted",
        payload: { books: promoted.books, notes: promotions.flatMap((p) => p.noteIds) },
      });
    }
    if (!dryRun && options.audit && !isEmptyPlan(plan)) {
      // 本文は残さない（A1-5）。どの本がどこへ行ったかは id で辿れる。
      await options.audit({
        action: "memory.shelf.organized",
        payload: {
          merges: plan.merges.map((m) => ({ keep: m.keep, absorbed: m.absorb })),
          retitled: plan.retitles.map((r) => r.id),
        },
      });
    }

    // 4. 忘却の適用（§3.4）: 減衰 → strength<0.2 を書庫へ
    const forgetting = dryRun
      ? await previewForgetting(pool, agentId, lambda)
      : await applyForgetting(pool, agentId, lambda);

    return {
      entryDate,
      narrative,
      notesConsolidated: notes.rows.length,
      notesWithheld: withheld,
      booksDecayed: forgetting.decayed,
      booksArchived: forgetting.archived,
      booksPromoted: promoted.books,
      notesPromoted: promoted.notes,
      promotions,
      booksMerged: applied.merged,
      booksAbsorbed: applied.absorbed,
      booksRetitled: applied.retitled,
      plan,
      dryRun,
    };
  } finally {
    await pool.end();
  }
}

/** いまの本棚を読んでモデルに整理させ、実在する本だけに絞った計画を返す。 */
async function organizeShelf(
  pool: pg.Pool,
  agentId: string,
  complete: (req: { system: string; user: string }) => Promise<string>,
): Promise<OrganizePlan> {
  const res = await pool.query<ShelfBook>(
    `SELECT id, title, card, strength FROM books
      WHERE agent_id = $1 AND status = 'active' ORDER BY created_at ASC`,
    [agentId],
  );
  // 1冊なら畳む相手がいない。モデルを呼ぶ意味が無いので呼ばない。
  if (res.rows.length < 2) return EMPTY_PLAN;

  const books = res.rows.map((b) => ({ ...b, id: Number(b.id) }));
  let text: string;
  try {
    text = await complete(buildOrganizePrompt(books));
  } catch {
    // 司書が不調でも夜間バッチ全体は止めない。今夜は整理しないだけ。
    return EMPTY_PLAN;
  }
  return validatePlan(parseOrganizePlan(text), books);
}

/**
 * 計画を適用する。**1つのトランザクションで行う** — 畳まれる側だけ書庫に落ちて
 * 残す側が更新されないと、内容がどこにも無い状態になる。
 *
 * 畳まれた本は消さずに `archived`（可逆, privacy-and-memory-policy §3 の L1）。
 */
async function applyPlan(
  pool: pg.Pool,
  agentId: string,
  plan: OrganizePlan,
): Promise<{ merged: number; absorbed: number; retitled: number }> {
  const client = await pool.connect();
  let absorbed = 0;
  let retitled = 0;
  try {
    await client.query("BEGIN");
    for (const m of plan.merges) {
      // **残す本の元の文章も書庫に残す。** これを入れないと、畳まれた側（archived）は
      // 後から読めるのに、残した側の元文だけが上書きで消える——整理が部分的に
      // 不可逆になる。本棚の操作は可逆であること（privacy-and-memory-policy §3 の L1）。
      await client.query(
        `INSERT INTO books (agent_id, title, source, card, shelf, strength, status, created_at)
         SELECT agent_id, title, source, card, shelf, 0, 'archived', created_at
           FROM books WHERE agent_id = $1 AND id = $2 AND status = 'active'`,
        [agentId, m.keep],
      );
      // 残す本の strength は組の最大を引き継ぐ。まとめたことで弱くならないように。
      await client.query(
        `UPDATE books SET title = $3, card = $4,
                strength = (SELECT max(strength) FROM books WHERE agent_id = $1 AND id = ANY($5))
          WHERE agent_id = $1 AND id = $2 AND status = 'active'`,
        [agentId, m.keep, m.title, m.card, [m.keep, ...m.absorb]],
      );
      const res = await client.query(
        `UPDATE books SET status = 'archived', strength = 0
          WHERE agent_id = $1 AND id = ANY($2) AND status = 'active'`,
        [agentId, m.absorb],
      );
      absorbed += res.rowCount ?? 0;
    }
    for (const r of plan.retitles) {
      const res = await client.query(
        "UPDATE books SET title = $3 WHERE agent_id = $1 AND id = $2 AND status = 'active'",
        [agentId, r.id, r.title],
      );
      retitled += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { merged: plan.merges.length, absorbed, retitled };
}

/** 忘却を適用する（§3.4）。減衰させてから、しきい値を割った本を書庫へ。 */
async function applyForgetting(
  pool: pg.Pool,
  agentId: string,
  lambda: number,
): Promise<{ decayed: number; archived: number }> {
  const decayed = await pool.query(
    "UPDATE books SET strength = strength * exp(-$2::double precision) WHERE agent_id = $1 AND status = 'active'",
    [agentId, lambda],
  );
  const archived = await pool.query(
    "UPDATE books SET status = 'archived' WHERE agent_id = $1 AND status = 'active' AND strength < 0.2",
    [agentId],
  );
  return { decayed: decayed.rowCount ?? 0, archived: archived.rowCount ?? 0 };
}

/** 同じ判定を書き込まずに数えるだけ（dryRun 用）。 */
async function previewForgetting(
  pool: pg.Pool,
  agentId: string,
  lambda: number,
): Promise<{ decayed: number; archived: number }> {
  const res = await pool.query<{ decayed: string; archived: string }>(
    `SELECT count(*) AS decayed,
            count(*) FILTER (WHERE strength * exp(-$2::double precision) < 0.2) AS archived
       FROM books WHERE agent_id = $1 AND status = 'active'`,
    [agentId, lambda],
  );
  return {
    decayed: Number(res.rows[0]?.decayed ?? 0),
    archived: Number(res.rows[0]?.archived ?? 0),
  };
}

/** 昇格の候補（期間内・未昇格のメモ）を読んでモデルに掛け、実在するメモだけに絞った計画を返す。 */
async function planPromotions(
  pool: pg.Pool,
  agentId: string,
  complete: (req: { system: string; user: string }) => Promise<string>,
  windowDays: number,
): Promise<PromotionPlan[]> {
  const res = await pool.query<PromotableNote & { sensitive_categories: string[] | null }>(
    `SELECT id, content, sensitive_categories FROM notes
      WHERE agent_id = $1 AND promoted_at IS NULL
        AND created_at > now() - ($2 || ' days')::interval
      ORDER BY created_at ASC`,
    [agentId, String(windowDays)],
  );
  const notes = res.rows.map((n) => ({ ...n, id: Number(n.id) }));
  // 3件に満たないなら、どう転んでも昇格しない。モデルを呼ぶ意味が無いので呼ばない。
  if (notes.length < MIN_NOTES_FOR_PROMOTION) return [];

  let text: string;
  try {
    text = await complete(buildPromotionPrompt(notes));
  } catch {
    // 司書が不調でも夜間バッチ全体は止めない。今夜は昇格しないだけ。
    return [];
  }
  return validatePromotions(parsePromotions(text), notes);
}

/**
 * 昇格を適用する。**1つのトランザクションで行う** — 本だけできてメモに印が付かないと、
 * 翌晩また同じ本が生まれる。
 */
async function applyPromotions(
  pool: pg.Pool,
  agentId: string,
  plans: PromotionPlan[],
): Promise<{ books: number; notes: number }> {
  const client = await pool.connect();
  let notes = 0;
  try {
    await client.query("BEGIN");
    for (const plan of plans) {
      // 材料のメモに付いていた印は本にも引き継ぐ。**昇格を印の抜け道にしない**
      const marks = await client.query<{ categories: string[] }>(
        `SELECT coalesce(array_agg(DISTINCT c), '{}') AS categories
           FROM notes, unnest(coalesce(sensitive_categories, '{}')) AS c
          WHERE agent_id = $1 AND id = ANY($2)`,
        [agentId, plan.noteIds],
      );
      await client.query(
        `INSERT INTO books (agent_id, title, card, source, origin, source_note_ids, sensitive_categories)
         VALUES ($1, $2, $3, $4, 'promoted', $5, $6)`,
        [
          agentId,
          plan.title,
          plan.card,
          `notes:${plan.noteIds.join(",")}`,
          plan.noteIds,
          marks.rows[0]?.categories ?? [],
        ],
      );
      const res = await client.query(
        "UPDATE notes SET promoted_at = now() WHERE agent_id = $1 AND id = ANY($2) AND promoted_at IS NULL",
        [agentId, plan.noteIds],
      );
      notes += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { books: plans.length, notes };
}
