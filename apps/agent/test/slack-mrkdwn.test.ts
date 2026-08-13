/**
 * Slack の書式（mrkdwn）への変換。env 不要。
 *
 * モデルは Markdown を書き、Slack はそれを解釈しない。`**強調**` が記号のまま出ると
 * 読みにくいだけでなく、「書式を間違える同僚」に見える。
 *
 * ここで固めたいのは変換そのものより、**壊さないこと**——
 * コードの中の記号は書式ではなく中身なので、書き換えると動かないものを渡すことになる。
 */

import { toSlackMrkdwn } from "@edv4h/russell-plugin-surface-slack";
import { expect, test } from "vitest";

test("強調は Slack の書き方へ", () => {
  expect(toSlackMrkdwn("これは **重要** です")).toBe("これは *重要* です");
  expect(toSlackMrkdwn("***かなり重要***")).toBe("*かなり重要*");
  expect(toSlackMrkdwn("~~取り消し~~")).toBe("~取り消し~");
});

test("見出しは太字の行にする（mrkdwn に見出しは無い）", () => {
  expect(toSlackMrkdwn("## まとめ")).toBe("*まとめ*");
  expect(toSlackMrkdwn("# 概要 #")).toBe("*概要*");
  // 見出しの中の強調も潰す（`*` が二重にならない）
  expect(toSlackMrkdwn("### **結論**")).toBe("*結論*");
});

test("箇条書きは中黒。字下げは残す", () => {
  expect(toSlackMrkdwn("- ひとつ\n- ふたつ")).toBe("• ひとつ\n• ふたつ");
  expect(toSlackMrkdwn("  - 子")).toBe("  • 子");
  expect(toSlackMrkdwn("* 星でも")).toBe("• 星でも");
});

test("リンクは Slack の書き方へ", () => {
  expect(toSlackMrkdwn("[設計書](https://example.com/a)を見て")).toBe(
    "<https://example.com/a|設計書>を見て",
  );
});

test("表は作れないので、区切りだけ読める形にする（内容は落とさない）", () => {
  const md = ["| 項目 | 状態 |", "|---|---|", "| A | 完了 |"].join("\n");

  expect(toSlackMrkdwn(md)).toBe("項目 ｜ 状態\nA ｜ 完了");
});

test("**コードブロックの中は触らない**（記号は書式ではなく中身）", () => {
  const md = ["```ts", "const x = a ** b; // **強調ではない**", "```"].join("\n");

  expect(toSlackMrkdwn(md)).toBe(md);
});

test("**コード片の中も触らない**", () => {
  expect(toSlackMrkdwn("`a ** b` は掛け算")).toBe("`a ** b` は掛け算");
  // コード片の外は変換される
  expect(toSlackMrkdwn("`code` と **強調**")).toBe("`code` と *強調*");
});

test("変換できないものは、落とさずそのまま残す", () => {
  // 読みにくくなるだけで済む方が、内容が消えるより良い
  expect(toSlackMrkdwn("> 引用はそのまま")).toBe("> 引用はそのまま");
  expect(toSlackMrkdwn("1. 番号付きもそのまま")).toBe("1. 番号付きもそのまま");
  expect(toSlackMrkdwn("普通の文。")).toBe("普通の文。");
  expect(toSlackMrkdwn("")).toBe("");
});
