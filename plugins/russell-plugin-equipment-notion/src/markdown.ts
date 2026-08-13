/**
 * Markdown を Notion のブロックにする。
 *
 * 最初は**段落だけ**にしていた。承認画面で「何が書かれるか」を見せきるためだったが、
 * 出来上がったページが読みにくい——見出しも箇条書きも無い文章が続くだけになる。
 *
 * **Markdown を書かせて、決定論で変換する**なら両立する。承認画面に出すのは
 * **Markdown のまま**で、人はそれを読んで判断できるし、変換は機械的なので
 * 「見せたものと違うものが書かれる」ことがない。
 *
 * 対応するのは、実際に使う分だけ:
 * 見出し・箇条書き・番号付き・チェックボックス・引用・区切り線・コード・段落。
 * **表は対応しない**（Notion の表は行と列を別ブロックで組む必要があり、
 * 変換の複雑さに見合わない。Markdown の表は段落として残す方がまだ読める）。
 */

/** Notion のブロック1つあたりの本文上限（2000）に対する安全側の値。 */
const MAX_TEXT = 1800;
/** 1回の作成で渡せるブロック数（100）に対する安全側の値。 */
const MAX_BLOCKS = 99;

interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean };
}

/**
 * 行の中の装飾を Notion の rich_text にする。
 *
 * **コード片を先に切り出す**——`` `**x**` `` の中身は装飾ではなく文字である。
 */
export function toRichText(line: string): RichText[] {
  const out: RichText[] = [];
  // コード片で分割（奇数番がコード片）
  for (const [i, chunk] of line.split(/(`[^`]+`)/).entries()) {
    if (!chunk) continue;
    if (i % 2 === 1) {
      out.push({
        type: "text",
        text: { content: chunk.slice(1, -1) },
        annotations: { code: true },
      });
      continue;
    }
    // リンク → 太字 → 斜体 → 打ち消し の順に切り出す
    const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*]+)\*/g;
    let last = 0;
    let m: RegExpExecArray | null = pattern.exec(chunk);
    while (m !== null) {
      if (m.index > last) out.push(plain(chunk.slice(last, m.index)));
      if (m[1] && m[2]) {
        out.push({ type: "text", text: { content: m[1], link: { url: m[2] } } });
      } else if (m[3]) {
        out.push({ type: "text", text: { content: m[3] }, annotations: { bold: true } });
      } else if (m[4]) {
        out.push({ type: "text", text: { content: m[4] }, annotations: { strikethrough: true } });
      } else if (m[5]) {
        out.push({ type: "text", text: { content: m[5] }, annotations: { italic: true } });
      }
      last = m.index + m[0].length;
      m = pattern.exec(chunk);
    }
    if (last < chunk.length) out.push(plain(chunk.slice(last)));
  }
  return out.length > 0 ? out : [plain("")];
}

const plain = (content: string): RichText => ({
  type: "text",
  text: { content: content.slice(0, MAX_TEXT) },
});

const block = (type: string, line: string, extra: Record<string, unknown> = {}) => ({
  object: "block",
  type,
  [type]: { rich_text: toRichText(line.slice(0, MAX_TEXT)), ...extra },
});

/**
 * Markdown をブロックの列にする。
 *
 * **読めない書き方が来ても落とさない。** 解釈できない行は段落として残す——
 * 変換に失敗して消えるより、そのまま載る方がよい。
 */
export function toBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // コードブロック（``` から ``` まで）。**中は一切解釈しない**
    const fence = trimmed.match(/^```(\w*)/);
    if (fence) {
      const language = fence[1] || "plain text";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // 閉じる ``` を飛ばす
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: [plain(body.join("\n"))],
          language,
        },
      });
      continue;
    }
    i++;

    if (trimmed === "") continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (heading) {
      blocks.push(block(`heading_${heading[1]?.length ?? 1}`, heading[2] ?? ""));
      continue;
    }
    const todo = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      blocks.push(
        block("to_do", todo[2] ?? "", { checked: (todo[1] ?? " ").toLowerCase() === "x" }),
      );
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(block("bulleted_list_item", bullet[1] ?? ""));
      continue;
    }
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push(block("numbered_list_item", numbered[1] ?? ""));
      continue;
    }
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(block("quote", quote[1] ?? ""));
      continue;
    }
    // 段落。長い行は分ける（1ブロックの上限がある）
    for (let at = 0; at < trimmed.length; at += MAX_TEXT) {
      blocks.push(block("paragraph", trimmed.slice(at, at + MAX_TEXT)));
    }
  }

  // **切り詰めたことは黙らない。** 黙って消えると、書いたつもりで欠ける
  if (blocks.length > MAX_BLOCKS) {
    const kept = blocks.slice(0, MAX_BLOCKS);
    kept.push(block("paragraph", "（長すぎるため、ここから先は省略しました）"));
    return kept;
  }
  return blocks;
}
