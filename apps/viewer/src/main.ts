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
import { BOXES, escapeHtml, renderPage, renderTable } from "./render.js";

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
    columns: ["created_at", "agent_id", "context_id", "content", "expires_at", "consolidated"],
    sql: `SELECT created_at, agent_id, context_id, content, expires_at, consolidated
            FROM notes WHERE ($1::text IS NULL OR agent_id = $1) ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/books": {
    ...pick("/books"),
    columns: ["created_at", "agent_id", "title", "card", "shelf", "strength", "source"],
    sql: `SELECT created_at, agent_id, title, card, shelf, round(strength::numeric, 2) AS strength, source
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
