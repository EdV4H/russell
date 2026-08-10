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
  sql: string;
}

/** 箱ごとの見せ方。**SELECT だけ**。ビューアは書き込みの経路を持たない。 */
const VIEWS: Record<string, View> = {
  "/notes": {
    ...pick("/notes"),
    columns: ["created_at", "agent_id", "context_id", "content", "expires_at", "consolidated"],
    sql: `SELECT created_at, agent_id, context_id, content, expires_at, consolidated
            FROM notes ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/books": {
    ...pick("/books"),
    columns: ["created_at", "agent_id", "title", "card", "shelf", "strength", "source"],
    sql: `SELECT created_at, agent_id, title, card, shelf, round(strength::numeric, 2) AS strength, source
            FROM books WHERE status = 'active' ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/archive": {
    ...pick("/archive"),
    columns: ["created_at", "agent_id", "title", "card", "strength"],
    sql: `SELECT created_at, agent_id, title, card, round(strength::numeric, 2) AS strength
            FROM books WHERE status = 'archived' ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/journal": {
    ...pick("/journal"),
    columns: ["entry_date", "agent_id", "narrative", "events"],
    sql: `SELECT entry_date, agent_id, narrative, events
            FROM journal_entries ORDER BY entry_date DESC LIMIT ${LIMIT}`,
  },
  "/events": {
    ...pick("/events"),
    columns: ["ts", "agent_id", "actor", "action", "trust_label", "payload"],
    sql: `SELECT ts, agent_id, actor, action, trust_label, payload
            FROM event_log ORDER BY id DESC LIMIT ${LIMIT}`,
  },
  "/stops": {
    ...pick("/stops"),
    columns: ["target", "stopped", "by_actor", "reason", "updated_at"],
    sql: "SELECT target, stopped, by_actor, reason, updated_at FROM agent_stops ORDER BY updated_at DESC",
  },
};

function pick(path: string): { title: string; description: string } {
  const box = BOXES.find((b) => b.path === path);
  return { title: box?.title ?? path, description: box?.description ?? "" };
}

/** 概要。何がどれだけ入っているかを一目で。 */
async function overview(pool: pg.Pool): Promise<string> {
  const counts = await pool.query<{ box: string; n: string }>(`
    SELECT 'メモ帳' AS box, count(*)::text AS n FROM notes
    UNION ALL SELECT '本棚', count(*)::text FROM books WHERE status = 'active'
    UNION ALL SELECT '書庫', count(*)::text FROM books WHERE status = 'archived'
    UNION ALL SELECT '日記', count(*)::text FROM journal_entries
    UNION ALL SELECT '監査ログ', count(*)::text FROM event_log
    UNION ALL SELECT '凍結中', count(*)::text FROM agent_stops WHERE stopped`);
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
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    try {
      if (path === "/") {
        send(200, renderPage("/", "Russell の記憶", "読み取り専用ビューア", await overview(pool)));
        return;
      }
      const view = VIEWS[path];
      if (!view) {
        send(
          404,
          renderPage(path, "見つかりません", "", "<p class=empty>そのページはありません。</p>"),
        );
        return;
      }
      const { rows } = await pool.query(view.sql);
      send(200, renderPage(path, view.title, view.description, renderTable(view.columns, rows)));
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
