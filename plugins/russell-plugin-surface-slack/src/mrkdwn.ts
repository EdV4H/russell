/**
 * Markdown を Slack の書式（mrkdwn）へ直す。
 *
 * モデルは Markdown を書く。Slack はそれを解釈しないので、`**強調**` や `## 見出し`、
 * `[題](url)` が**記号のまま表示される**。読みにくいだけでなく、
 * 「この同僚は書式を間違える」という印象がそのまま残る。
 *
 * **通信面の仕事である。** コアは文章を作るだけで、どう見えるかは面の都合
 * （CLI では Markdown のままでよい）。リアクションの絵文字と同じ切り分け。
 *
 * > [!IMPORTANT]
 * > **コード部分には触らない。** ` ``` ` の中や `` `…` `` の中の記号は書式ではなく中身で、
 * > 書き換えると**動かないコードを渡すことになる**。ここが直し忘れやすい。
 */

/** 見出しは mrkdwn に無い。太字の行にする（`#` が残るよりは読める）。 */
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
/** 箇条書き。`-` `*` `+` を中黒へ。ネストの深さは字下げで残す。 */
const BULLET = /^(\s*)[-*+]\s+/;
/** 表の区切り行（`|---|---|`）。mrkdwn に表は無いので落とす。 */
const TABLE_RULE = /^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

/** 行の中の書式。**コード片（`…`）は避けて当てる**。 */
function inline(text: string): string {
  const parts = text.split(/(`[^`]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // コード片はそのまま
      return (
        part
          // [題](url) → <url|題>。**先に当てる**（この後の記号変換で壊さないため）
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
          // ***強い強調*** → *太字*（Slack に入れ子の強調は無い）
          .replace(/\*\*\*([^*]+)\*\*\*/g, "*$1*")
          // **太字** → *太字*
          .replace(/\*\*([^*]+)\*\*/g, "*$1*")
          // ~~打ち消し~~ → ~打ち消し~
          .replace(/~~([^~]+)~~/g, "~$1~")
      );
    })
    .join("");
}

/**
 * Slack へ送る前に通す。**変換できないものは落とさず、そのまま残す**——
 * 読みにくくなるだけで済む方が、内容が消えるより良い。
 */
export function toSlackMrkdwn(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    // コードブロックの中は**一切触らない**（記号は書式ではなく中身）
    if (inFence) {
      out.push(line);
      continue;
    }
    if (TABLE_RULE.test(line) && line.includes("|")) continue; // 区切り行は落とす
    const table = line.match(TABLE_ROW);
    if (table) {
      // 表は作れないので、区切りだけ読める形にする（内容は落とさない）
      out.push(
        inline(
          table[1]
            ?.split("|")
            .map((c) => c.trim())
            .filter(Boolean)
            .join(" ｜ ") ?? "",
        ),
      );
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      // 見出しの中が既に強調なら二重にしない（`**結論**` が `**結論**` のまま残る）
      const body = inline(heading[1] ?? "").replace(/^\*(.+)\*$/, "$1");
      out.push(`*${body}*`);
      continue;
    }
    out.push(inline(line.replace(BULLET, "$1• ")));
  }
  return out.join("\n");
}
