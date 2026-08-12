/**
 * 表示だけを担う純関数群。DB も HTTP も知らないのでテストできる。
 *
 * 記憶の中身をそのまま画面に出すので、**エスケープは最重要**。本文は他者が書いた
 * untrusted テキストで、`<script>` も `<img onerror=…>` も普通に入りうる（§12-3）。
 */

/** 記憶の箱。URL とページ見出しの単位。 */
export interface Box {
  path: string;
  title: string;
  description: string;
}

export const BOXES: Box[] = [
  { path: "/notes", title: "メモ帳", description: "スレッド単位の走り書き。TTL 既定7日（§3.1）" },
  { path: "/books", title: "本棚", description: "読書カード。意図的に覚えたもの（§3.1）" },
  {
    path: "/terms",
    title: "単語帳",
    description: "このチームでだけ通じる言葉。忘却しない・別名で引く（ADR 0008）",
  },
  {
    path: "/todos",
    title: "作業",
    description: "引き受けたまま終わっていないもの。忘却しない・止まった日数が見える（ADR 0009）",
  },
  {
    path: "/people",
    title: "個人カルテ",
    description: "一緒に働いて分かった事実だけ。評価は書かない・日報に出さない（ADR 0008）",
  },
  {
    path: "/archive",
    title: "書庫",
    description: "忘却曲線と「忘れて」で沈んだ本。削除はしない（§3.4）",
  },
  { path: "/journal", title: "日記", description: "夜間バッチが書く1日1エントリ（§4）" },
  {
    path: "/events",
    title: "監査ログ",
    description: "全アクション。追記専用・本文は入らない（§3.1）",
  },
  { path: "/stops", title: "キルスイッチ", description: "凍結状態（§12-4）" },
];

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 長い本文は折り返して読めるが、一覧が崩れるほどは出さない。 */
export function truncate(value: unknown, max = 400): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "<span class=nil>—</span>";
  if (value instanceof Date) return escapeHtml(value.toISOString().replace("T", " ").slice(0, 19));
  if (typeof value === "object") return escapeHtml(truncate(JSON.stringify(value)));
  return escapeHtml(truncate(value));
}

export function renderTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "<p class=empty>まだ何も入っていません。</p>";
  const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${formatCell(row[c])}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const STYLE = `
:root { color-scheme: light dark; --line:#8883; --muted:#8888; }
body { font: 14px/1.7 system-ui, sans-serif; margin: 0; padding: 0 24px 64px; }
header { padding: 24px 0 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 20px; margin: 0 0 4px; }
nav { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 12px; }
nav a { text-decoration: none; }
nav a.on { font-weight: 600; text-decoration: underline; }
p.desc { color: var(--muted); margin: 16px 0; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; }
th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line);
         vertical-align: top; font-variant-numeric: tabular-nums; }
th { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
td { max-width: 60ch; overflow-wrap: anywhere; }
.nil, .empty, footer { color: var(--muted); }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; }
.counts { display: flex; flex-wrap: wrap; gap: 12px 32px; margin-top: 16px; }
.counts b { font-size: 22px; font-weight: 600; display: block; }
nav.agents { margin-top: 8px; font-size: 13px; }
nav.agents span { color: var(--muted); margin-right: 4px; }
`;

/**
 * 個体の切り替え。記憶は個体間で共有しない（§8.4）ので、見る側も個体単位で見られる必要がある。
 * `undefined` は「全個体」。
 */
export function renderAgentPicker(
  agents: string[],
  current: string | undefined,
  path: string,
): string {
  if (agents.length === 0) return "";
  const link = (label: string, agent?: string) => {
    const href = agent ? `${path}?agent=${encodeURIComponent(agent)}` : path;
    const on = agent === current ? " class=on" : "";
    return `<a href="${escapeHtml(href)}"${on}>${escapeHtml(label)}</a>`;
  };
  return `<nav class=agents><span>個体:</span>${link("全個体")}${agents
    .map((a) => link(a, a))
    .join("")}</nav>`;
}

export interface PageOptions {
  /** いま選ばれている個体。未指定なら全個体。 */
  agent?: string;
  /** 切り替え先の候補。 */
  agents?: string[];
}

export function renderPage(
  current: string,
  title: string,
  description: string,
  body: string,
  options: PageOptions = {},
): string {
  // 箱を移っても個体の絞り込みは保つ。毎回選び直させない。
  const suffix = options.agent ? `?agent=${encodeURIComponent(options.agent)}` : "";
  const nav = BOXES.map(
    (b) =>
      `<a href="${escapeHtml(`${b.path}${suffix}`)}"${b.path === current ? " class=on" : ""}>${escapeHtml(b.title)}</a>`,
  ).join("");
  const picker = renderAgentPicker(options.agents ?? [], options.agent, current);
  return `<!doctype html><html lang=ja><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Russell</title><style>${STYLE}</style></head><body>
<header><h1>${escapeHtml(title)}</h1><nav><a href="${escapeHtml(`/${suffix}`)}"${current === "/" ? " class=on" : ""}>概要</a>${nav}</nav>${picker}</header>
<p class=desc>${escapeHtml(description)}</p>
${body}
<footer>読み取り専用。書き込みはしない。localhost にのみ待ち受ける（記憶の中身が出るため）。</footer>
</body></html>`;
}
