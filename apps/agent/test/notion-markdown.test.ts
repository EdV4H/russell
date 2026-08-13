/**
 * Markdown → Notion のブロック。env 不要。
 *
 * 最初は**段落だけ**にしていた（承認画面で「何が書かれるか」を見せきるため）。
 * その結果、出来上がったページが読みにくかった。
 *
 * **Markdown を書かせて決定論で変換する**なら両立する——承認画面に出すのは Markdown の
 * ままで、人はそれを読んで判断でき、変換は機械的なので「見せたものと違うものが書かれる」
 * ことがない。ここで固めたいのは、その**機械的であること**。
 */

import { toBlocks, toRichText } from "@edv4h/russell-plugin-equipment-notion";
import { expect, test } from "vitest";

/** ブロックの型だけを並べる（構造を見るため）。 */
const types = (md: string) => toBlocks(md).map((b) => (b as { type: string }).type);
/** 1つ目のブロックの本文（テキストだけ）。 */
const textOf = (md: string) => {
  const first = toBlocks(md)[0] as Record<string, { rich_text?: { text: { content: string } }[] }>;
  const key = (first as unknown as { type: string }).type;
  return (first[key]?.rich_text ?? []).map((r) => r.text.content).join("");
};

test("見出し・箇条書き・番号・引用・区切り線が、それぞれのブロックになる", () => {
  const md = ["# 見出し", "- 箇条書き", "1. 番号", "> 引用", "---", "普通の段落"].join("\n");

  expect(types(md)).toEqual([
    "heading_1",
    "bulleted_list_item",
    "numbered_list_item",
    "quote",
    "divider",
    "paragraph",
  ]);
});

test("見出しの深さを保つ（### まで）", () => {
  expect(types("## 中見出し")).toEqual(["heading_2"]);
  expect(types("### 小見出し")).toEqual(["heading_3"]);
  // Notion に heading_4 は無い。**深すぎるものは段落にする**（消さない）
  expect(types("#### 深すぎる")).toEqual(["paragraph"]);
});

test("チェックボックスは状態まで持つ", () => {
  const blocks = toBlocks("- [ ] まだ\n- [x] 済み") as { to_do: { checked: boolean } }[];

  expect(types("- [ ] まだ")).toEqual(["to_do"]);
  expect(blocks[0]?.to_do.checked).toBe(false);
  expect(blocks[1]?.to_do.checked).toBe(true);
});

test("**コードブロックの中は解釈しない**（記号は書式ではなく中身）", () => {
  const md = ["```ts", "const x = a ** b; // # 見出しではない", "- 箇条書きでもない", "```"].join(
    "\n",
  );
  const blocks = toBlocks(md) as {
    type: string;
    code: { language: string; rich_text: { text: { content: string } }[] };
  }[];

  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("code");
  expect(blocks[0]?.code.language).toBe("ts");
  expect(blocks[0]?.code.rich_text[0]?.text.content).toContain("a ** b");
  expect(blocks[0]?.code.rich_text[0]?.text.content).toContain("# 見出しではない");
});

test("行の中の装飾を持つ", () => {
  const rich = toRichText("これは **重要** で `code` と [リンク](https://example.com) です");

  expect(rich.find((r) => r.text.content === "重要")?.annotations?.bold).toBe(true);
  expect(rich.find((r) => r.text.content === "code")?.annotations?.code).toBe(true);
  expect(rich.find((r) => r.text.content === "リンク")?.text.link?.url).toBe("https://example.com");
});

test("コード片の中は装飾として扱わない", () => {
  const rich = toRichText("`a ** b` は掛け算");

  expect(rich[0]?.text.content).toBe("a ** b");
  expect(rich[0]?.annotations?.code).toBe(true);
  expect(rich.some((r) => r.annotations?.bold)).toBe(false);
});

test("**解釈できない行も落とさない**（変換に失敗して消えるより、そのまま載る方がよい）", () => {
  // 表は対応していない。段落として残る
  expect(types("| a | b |")).toEqual(["paragraph"]);
  expect(textOf("| a | b |")).toBe("| a | b |");
});

test("空行は捨てる（段落の区切りであって、中身ではない）", () => {
  expect(types("あ\n\n\nい")).toEqual(["paragraph", "paragraph"]);
  expect(toBlocks("")).toEqual([]);
  expect(toBlocks("   \n  ")).toEqual([]);
});

test("長すぎるときは切るが、**切ったことは黙らない**", () => {
  const md = Array.from({ length: 200 }, (_, i) => `- 項目${i}`).join("\n");
  const blocks = toBlocks(md);

  expect(blocks.length).toBeLessThanOrEqual(100); // Notion の上限
  const last = blocks.at(-1) as { paragraph: { rich_text: { text: { content: string } }[] } };
  expect(last.paragraph.rich_text[0]?.text.content).toContain("省略しました");
});
