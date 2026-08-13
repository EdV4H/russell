/**
 * 記憶の中身を見るための読み取り専用ビューア（§10.1 記憶の全公開）。
 *
 * **エージェントとは別プロセス。** DB さえ見えれば動くので、Bob が落ちているときでも
 * 中を見られる——不調を調べたいのはまさにそのときなので、依存させない。
 *
 *   pnpm --filter @edv4h/russell-viewer start   # http://127.0.0.1:4000
 *
 * 認証は無い。代わりに **127.0.0.1 にしか待ち受けない**（記憶の本文がそのまま出るため）。
 * 外に出す必要が生じたら、そのときは認証と一緒に設計する。
 */

import { createServer } from "node:http";
import pg from "pg";
import { BOXES, escapeHtml, renderDefs, renderPage, renderTable } from "./render.js";

const PORT = Number(process.env.RUSSELL_VIEWER_PORT ?? 4000);
const HOST = "127.0.0.1";
const LIMIT = 200;

interface View {
  title: string;
  description: string;
  columns: string[];
  /**
   * 個体で絞る SQL。**個体 ID は URL から来る untrusted な値**なので、
   * 文字列連結せずプレースホルダで渡す。`$1` が null なら全個体。
   */
  sql: string;
}

/** 箱ごとの見せ方。**SELECT だけ**。ビューアは書き込みの経路を持たない。 */
const VIEWS: Record<string, View> = {
  "/notes": {
    ...pick("/notes"),
    columns: [
      "created_at",
      "agent_id",
      "context_id",
      "content",
      "sensitive_categories",
      "promoted_at",
      "consolidated",
    ],
    // sensitive_categories を出すのは、**どのメモが日記に出ないか**を目で確かめられるようにするため（#54）
    sql: `SELECT created_at, agent_id, context_id, content, sensitive_categories, promoted_at, consolidated
            FROM notes WHERE ($1::text IS NULL OR agent_id = $1) ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/terms": {
    ...pick("/terms"),
    columns: ["updated_at", "agent_id", "name", "aliases", "summary", "sensitive_categories"],
    // 更新順に並べる。単語帳は**積み上がらず更新される**ので、created_at より updated_at が効く
    sql: `SELECT updated_at, agent_id, name, aliases, summary, sensitive_categories
            FROM entities
           WHERE type = 'term' AND ($1::text IS NULL OR agent_id = $1)
           ORDER BY updated_at DESC LIMIT ${LIMIT}`,
  },
  "/todos": {
    ...pick("/todos"),
    columns: ["state", "content", "waiting_for", "止まった日数", "agent_id", "updated_at"],
    // 止まっている順に見せる。**古いものが上**に来ないと、溜まっていることに気づけない
    sql: `SELECT state, content, waiting_for,
                 floor(extract(epoch from now() - updated_at) / 86400) AS "止まった日数",
                 agent_id, updated_at
            FROM todos
           WHERE ($1::text IS NULL OR agent_id = $1)
           ORDER BY (state IN ('open','waiting')) DESC, updated_at ASC LIMIT ${LIMIT}`,
  },
  "/people": {
    ...pick("/people"),
    columns: [
      "updated_at",
      "agent_id",
      "name",
      "aliases",
      "external_ids",
      "summary",
      "sensitive_categories",
    ],
    sql: `SELECT updated_at, agent_id, name, aliases, external_ids, summary, sensitive_categories
            FROM entities
           WHERE type = 'person' AND ($1::text IS NULL OR agent_id = $1)
           ORDER BY updated_at DESC LIMIT ${LIMIT}`,
  },
  "/books": {
    ...pick("/books"),
    columns: [
      "created_at",
      "agent_id",
      "title",
      "card",
      "origin",
      "strength",
      "sensitive_categories",
    ],
    // origin は「会話中に直接書かれた本」と「メモから昇格した本」の区別（ADR 0005）
    sql: `SELECT created_at, agent_id, title, card, origin, round(strength::numeric, 2) AS strength, sensitive_categories
            FROM books WHERE status = 'active' AND ($1::text IS NULL OR agent_id = $1) ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/archive": {
    ...pick("/archive"),
    columns: ["created_at", "agent_id", "title", "card", "strength"],
    sql: `SELECT created_at, agent_id, title, card, round(strength::numeric, 2) AS strength
            FROM books WHERE status = 'archived' AND ($1::text IS NULL OR agent_id = $1) ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/journal": {
    ...pick("/journal"),
    columns: ["entry_date", "agent_id", "narrative", "events"],
    sql: `SELECT entry_date, agent_id, narrative, events
            FROM journal_entries WHERE ($1::text IS NULL OR agent_id = $1) ORDER BY entry_date DESC LIMIT ${LIMIT}`,
  },
  "/events": {
    ...pick("/events"),
    columns: ["ts", "agent_id", "actor", "action", "trust_label", "payload"],
    sql: `SELECT ts, agent_id, actor, action, trust_label, payload
            FROM event_log WHERE ($1::text IS NULL OR agent_id = $1) ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/stops": {
    ...pick("/stops"),
    columns: ["target", "stopped", "by_actor", "reason", "updated_at"],
    // 凍結だけは `target`。全体停止（`*`）はどの個体を見ているときも出す——
    // 「この個体は止まっていない」と誤読させないため。
    sql: `SELECT target, stopped, by_actor, reason, updated_at FROM agent_stops
           WHERE ($1::text IS NULL OR target = $1 OR target = '*') ORDER BY updated_at DESC`,
  },
};

function pick(path: string): { title: string; description: string } {
  const box = BOXES.find((b) => b.path === path);
  return { title: box?.title ?? path, description: box?.description ?? "" };
}

/** 記憶を持っている個体の一覧。起動は必ず監査に残るので、そこから拾う。 */
async function agentIds(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query<{ agent_id: string }>(
    "SELECT DISTINCT agent_id FROM event_log ORDER BY agent_id",
  );
  return res.rows.map((r) => r.agent_id);
}

/** 概要。何がどれだけ入っているかを一目で。 */
async function overview(pool: pg.Pool, agent?: string): Promise<string> {
  const counts = await pool.query<{ box: string; n: string }>(
    `SELECT 'メモ帳' AS box, count(*)::text AS n FROM notes WHERE ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '本棚', count(*)::text FROM books WHERE status = 'active' AND ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '単語帳', count(*)::text FROM entities WHERE type = 'term' AND ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '個人カルテ', count(*)::text FROM entities WHERE type = 'person' AND ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '作業（未完了）', count(*)::text FROM todos WHERE state IN ('open','waiting') AND ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '書庫', count(*)::text FROM books WHERE status = 'archived' AND ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '日記', count(*)::text FROM journal_entries WHERE ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '監査ログ', count(*)::text FROM event_log WHERE ($1::text IS NULL OR agent_id = $1)
     UNION ALL SELECT '凍結中', count(*)::text FROM agent_stops WHERE stopped AND ($1::text IS NULL OR target = $1 OR target = '*')`,
    [agent ?? null],
  );
  const cards = counts.rows
    .map((r) => `<div><b>${escapeHtml(r.n)}</b>${escapeHtml(r.box)}</div>`)
    .join("");
  return `<div class=counts>${cards}</div>`;
}

/**
 * いま何で動いているか。**起動の監査から拾う**——気質はコードにあって DB には無いので、
 * リポジトリを読んでも「動いている個体がその版で再起動済みか」は分からない。
 *
 * 直近の `agent.started` が答えである。**古い値が出ることもあるが、それが事実**
 * （変更したのに再起動していない、という状態が見える方がよい）。
 */
async function agentProfile(pool: pg.Pool, agent?: string): Promise<string> {
  const res = await pool.query<{ ts: Date; agent_id: string; payload: Record<string, unknown> }>(
    `SELECT ts, agent_id, payload FROM event_log
      WHERE action = 'agent.started' AND ($1::text IS NULL OR agent_id = $1)
      ORDER BY id DESC LIMIT 1`,
    [agent ?? null],
  );
  const row = res.rows[0];
  if (!row) {
    return "<p class=empty>まだ一度も起動していません（起動は必ず監査に残ります）。</p>";
  }
  const p = row.payload ?? {};
  const t = (p.temperament ?? {}) as Record<string, unknown>;
  const defs = renderDefs([
    ["個体", row.agent_id],
    ["名前", t.name],
    ["最後の起動", row.ts],
    ["モード", p.mode],
    ["設定版", p.configVersion],
    ["モデル", p.model],
    ["口調", t.tone],
    ["背景", t.backstory],
    ["自発性 proactivity", t.proactivity],
    ["1日の発言上限", t.daily_speak_cap],
    ["好奇心 curiosity", t.curiosity],
    ["反応度 reaction_rate", t.reaction_rate],
    ["返信の長さ verbosity", t.verbosity ?? "normal（既定）"],
    ["プラグイン", p.plugins],
  ]);
  // **いつの値かを言う。** 再起動していなければ、リポジトリの値とここは食い違う
  return `${defs}<p class=desc>この値は<b>最後に起動したときのもの</b>です。
    気質を変えても、再起動するまでここは変わりません。</p>`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[viewer] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // idle 接続のエラーで落とさない（本体側と同じ扱い）。
  pool.on("error", (err) => console.error("[viewer] Postgres 接続エラー:", err.message));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const path = url.pathname;
    const agent = url.searchParams.get("agent") || undefined;
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    try {
      const agents = await agentIds(pool);
      const shell = { agent, agents };
      if (path === "/") {
        const body = await overview(pool, agent);
        send(200, renderPage("/", "Russell の記憶", "読み取り専用ビューア", body, shell));
        return;
      }
      if (path === "/agent") {
        const body = await agentProfile(pool, agent);
        const box = pick("/agent");
        send(200, renderPage(path, box.title, box.description, body, shell));
        return;
      }
      const view = VIEWS[path];
      if (!view) {
        const body = "<p class=empty>そのページはありません。</p>";
        send(404, renderPage(path, "見つかりません", "", body, shell));
        return;
      }
      const { rows } = await pool.query(view.sql, [agent ?? null]);
      const body = renderTable(view.columns, rows);
      send(200, renderPage(path, view.title, view.description, body, shell));
    } catch (err) {
      // 見えないより、見えない理由が見える方がよい。
      const detail = err instanceof Error ? err.message : String(err);
      send(500, renderPage(path, "読み出しに失敗", "", `<pre>${escapeHtml(detail)}</pre>`));
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[viewer] http://${HOST}:${PORT}`);
  });

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  server.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
