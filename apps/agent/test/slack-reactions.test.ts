/**
 * リアクションの絵文字選び（Slack 通信面）。env 不要。
 *
 * **コアは意味しか渡さない**（`noted` / `acknowledged`）。何で表すかは通信面の裁量なので、
 * ここで固めたいのは「文面に合った絵文字を選ぶ」ことと、**選び損ねても必ず何か付く**こと。
 * 絵文字を選り好みした結果、何も付かなくなるのが最悪である。
 */

import {
  createTextMemo,
  defaultReactionEmoji,
  pickReactionEmoji,
} from "@edv4h/russell-plugin-surface-slack";
import { expect, test } from "vitest";

test("文面に合わせて選ぶ", () => {
  expect(pickReactionEmoji("acknowledged", "ありがとうございます、助かりました")).toBe("pray");
  expect(pickReactionEmoji("acknowledged", "リリースしました！")).toBe("tada");
  expect(pickReactionEmoji("acknowledged", "今日もお疲れさまでした")).toBe("tea");
  expect(pickReactionEmoji("acknowledged", "今日からよろしくお願いします")).toBe("wave");
  expect(pickReactionEmoji("acknowledged", "これから頑張ってね、期待してる")).toBe("muscle");
  expect(pickReactionEmoji("acknowledged", "了解です")).toBe("+1");
});

test("当てはまらなければ既定（👀）", () => {
  expect(pickReactionEmoji("acknowledged", "そのあたりは来週やる予定です")).toBe("eyes");
});

test("**文面が分からないときは当てにいかない**", () => {
  // 再起動後や積み残しの確認では、元の文が手元に無いことがある。
  // そこで外した絵文字を付けるより、👀 の方がよい
  expect(pickReactionEmoji("acknowledged", undefined)).toBe("eyes");
  expect(pickReactionEmoji("acknowledged", "")).toBe("eyes");
});

test("「メモしました」は文面で変えない（自分が何をしたかの表明なので）", () => {
  expect(pickReactionEmoji("noted", "ありがとうございます")).toBe("memo");
  expect(pickReactionEmoji("noted", undefined)).toBe("memo");
});

test("逃げ道は標準の絵文字（ワークスペースに無い名前を逃げ道にしない）", () => {
  expect(defaultReactionEmoji("acknowledged")).toBe("eyes");
  expect(defaultReactionEmoji("noted")).toBe("memo");
});

// --- 本文の控え ---

test("本文を控えて、id で引ける", () => {
  const memo = createTextMemo();
  memo.remember("m1", "ありがとう");

  expect(memo.get("m1")).toBe("ありがとう");
  expect(memo.get("m2")).toBeUndefined();
});

test("id が無い発言は控えない（引きようがない）", () => {
  const memo = createTextMemo();
  memo.remember(undefined, "ありがとう");

  expect(memo.size).toBe(0);
});

test("上限を超えたら古い順に捨てる（常駐プロセスで際限なく溜めない）", () => {
  const memo = createTextMemo(3);
  for (const id of ["m1", "m2", "m3", "m4"]) memo.remember(id, `本文 ${id}`);

  expect(memo.size).toBe(3);
  expect(memo.get("m1")).toBeUndefined(); // 最も古いものが消える
  expect(memo.get("m4")).toBe("本文 m4");
});
