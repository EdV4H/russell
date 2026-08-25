/**
 * 字幕を発言に直す（#130）。ブラウザ不要。
 *
 * Meet の字幕は**書き換わりながら伸びる**。そのまま拾うと1つの発言が何十行にもなり、
 * 逆に雑に間引くと言い終わりが消える。ここが会議の記録の質を決める。
 *
 * > [!IMPORTANT]
 * > **ここは実際の会議を見るまで「正しい」とは言えない。** 字幕がどう更新されるかは
 * > Meet の実装であって、こちらの仕様ではない。このテストが固定しているのは
 * > **規則が意図どおりに働くこと**であって、規則が現実に合っていることではない。
 * > 最初の会議で `RUSSELL_MEET_DEBUG=1` の生ログと突き合わせること。
 */

import {
  SETTLE_MS,
  addressesMe,
  createCaptionState,
  drainCaptions,
  ingestCaptions,
} from "@edv4h/russell-plugin-meeting-browser";
import { expect, test } from "vitest";

const T0 = 1_000_000;
const say = (speaker: string, text: string) => ({ speaker, text });

test("喋っている間は、何も出さない", () => {
  const s = createCaptionState();

  expect(ingestCaptions(s, [say("丸山", "じゃあ")], T0)).toEqual([]);
  expect(ingestCaptions(s, [say("丸山", "じゃあ始め")], T0 + 300)).toEqual([]);
  // 伸びている間は「まだ喋っている」。ここで出すと1発言が細切れになる
  expect(ingestCaptions(s, [say("丸山", "じゃあ始めましょう")], T0 + 600)).toEqual([]);
});

test("**静かになったら、そこで1発言**", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "じゃあ始めましょう")], T0);

  expect(ingestCaptions(s, [say("丸山", "じゃあ始めましょう")], T0 + 500)).toEqual([]);
  const lines = ingestCaptions(s, [say("丸山", "じゃあ始めましょう")], T0 + SETTLE_MS);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.speaker).toBe("丸山");
  expect(lines[0]?.text).toBe("じゃあ始めましょう");
});

test("**同じものを二度出さない**（確定した後も枠は残る）", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "始めましょう")], T0);
  ingestCaptions(s, [say("丸山", "始めましょう")], T0 + SETTLE_MS);

  // 画面には残り続ける。ここで出し直すと、同じ言葉が記憶に二重に入る
  expect(ingestCaptions(s, [say("丸山", "始めましょう")], T0 + SETTLE_MS + 1000)).toEqual([]);
  expect(ingestCaptions(s, [say("丸山", "始めましょう")], T0 + SETTLE_MS + 5000)).toEqual([]);
});

test("**確定した後に続きを喋ったら、増えた分だけ出す**", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "始めましょう。")], T0);
  ingestCaptions(s, [say("丸山", "始めましょう。")], T0 + SETTLE_MS);

  // 同じ枠が伸びる。全文を出し直すと二重になる
  ingestCaptions(s, [say("丸山", "始めましょう。今日は配信の件です")], T0 + SETTLE_MS + 100);
  const lines = ingestCaptions(
    s,
    [say("丸山", "始めましょう。今日は配信の件です")],
    T0 + SETTLE_MS * 2 + 100,
  );

  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toBe("今日は配信の件です");
});

test("聞き取り直しで書き換わっても、1発言のまま", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "はいしんの件")], T0);
  // 伸びたのではなく書き換わった＝まだ喋っている
  expect(ingestCaptions(s, [say("丸山", "配信の件")], T0 + 400)).toEqual([]);

  const lines = ingestCaptions(s, [say("丸山", "配信の件")], T0 + 400 + SETTLE_MS);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toBe("配信の件");
});

test("**画面から消えたら、そこで終わり**（字幕は流れていく）", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "来週でお願いします")], T0);

  // 静止を待つ前に流れていった。捨てると発言が消える
  const lines = ingestCaptions(s, [say("松本", "了解です")], T0 + 500);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.speaker).toBe("丸山");
  expect(lines[0]?.text).toBe("来週でお願いします");
});

test("複数人が同時に喋っても、混ざらない", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "配信は"), say("松本", "資料は")], T0);
  const lines = ingestCaptions(s, [say("丸山", "配信は"), say("松本", "資料は")], T0 + SETTLE_MS);

  expect(lines).toHaveLength(2);
  expect(lines.map((l) => l.speaker).sort()).toEqual(["丸山", "松本"]);
});

test("**出るときに、言いかけを捨てない**", () => {
  const s = createCaptionState();
  ingestCaptions(s, [say("丸山", "では次回は来週の同じ時間で")], T0);

  // 最後の一言はたいてい決めの言葉なので、待っている分を捨てると痛い
  const lines = drainCaptions(s, T0 + 100);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toBe("では次回は来週の同じ時間で");
  // 出し切ったので、二度目は空
  expect(drainCaptions(s, T0 + 200)).toEqual([]);
});

test("空の枠は無視する（読めなかったのと発言0件を混ぜない）", () => {
  const s = createCaptionState();

  expect(ingestCaptions(s, [say("", ""), say("丸山", "  ")], T0)).toEqual([]);
  expect(ingestCaptions(s, [], T0 + SETTLE_MS)).toEqual([]);
});

test("名前で呼ばれたかを見る（呼ばれていない話に割り込まない）", () => {
  expect(addressesMe("Bob、それ調べられる？", "Bob")).toBe(true);
  expect(addressesMe("bob お願い", "Bob")).toBe(true);
  // 呼ばれていない発言に割り込むと、聞いているだけのつもりの人を驚かせる
  expect(addressesMe("配信は来週にしましょう", "Bob")).toBe(false);
  expect(addressesMe("Bob", "")).toBe(false);
});
