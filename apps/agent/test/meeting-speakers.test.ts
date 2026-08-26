/**
 * 「何を言ったか」と「誰が言ったか」を突き合わせる（#130・音声経路）。音声も会議も要らない。
 *
 * 音声から書き起こすと Meet の画面の作りから自由になれるが、**話者が失われる**。
 * Russell の記憶は「誰が言ったか」を軸に組んであるので、そこを捨てると記憶としては弱くなる。
 *
 * だから折衷する: **中身は音声から、話者は画面から。**
 * ここで固めたいのは、**話者が取れなかったときに、当てにいかないこと**。
 */

import {
  UNKNOWN_SPEAKER,
  attributeSpeakers,
  overlapMs,
  toSpeakingSpans,
} from "@edv4h/russell-plugin-meeting-browser";
import { expect, test } from "vitest";

const at = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();

test("重なっている長さを測る", () => {
  expect(overlapMs({ from: 0, to: 100 }, { from: 50, to: 200 })).toBe(50);
  expect(overlapMs({ from: 0, to: 100 }, { from: 100, to: 200 })).toBe(0);
  expect(overlapMs({ from: 0, to: 100 }, { from: 200, to: 300 })).toBe(0);
});

test("発言に話者を付ける", () => {
  const lines = attributeSpeakers(
    [{ from: 1000, to: 3000, text: "配信は来週にしましょう" }],
    [{ speaker: "丸山", from: 900, to: 3200 }],
    at,
  );

  expect(lines).toHaveLength(1);
  expect(lines[0]?.speaker).toBe("丸山");
  expect(lines[0]?.text).toBe("配信は来週にしましょう");
});

test("**発言が重なったら、いちばん長く喋っていた人に寄せる**", () => {
  // 会議では発言が重なる。完全に分けようとすると破綻する
  const lines = attributeSpeakers(
    [{ from: 1000, to: 3000, text: "そうですね" }],
    [
      { speaker: "松本", from: 900, to: 1400 }, // 400ms しか重ならない
      { speaker: "丸山", from: 1400, to: 3000 }, // 1600ms 重なる
    ],
    at,
  );

  expect(lines[0]?.speaker).toBe("丸山");
});

test("**誰とも重ならなければ、当てにいかない**", () => {
  const lines = attributeSpeakers(
    [{ from: 5000, to: 6000, text: "聞こえていた発言" }],
    [{ speaker: "丸山", from: 0, to: 1000 }],
    at,
  );

  // 当てた話者は、当てたと分からない。**分からないと書く方が役に立つ**
  expect(lines[0]?.speaker).toBe(UNKNOWN_SPEAKER);
  expect(lines[0]?.text).toBe("聞こえていた発言");
});

test("**話者が一人も取れなくても、中身は捨てない**（片方が壊れても残る）", () => {
  const lines = attributeSpeakers([{ from: 0, to: 1000, text: "決まりました" }], [], at);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.speaker).toBe(UNKNOWN_SPEAKER);
});

test("空の書き起こしは落とす", () => {
  expect(attributeSpeakers([{ from: 0, to: 100, text: "   " }], [], at)).toEqual([]);
});

test("**続けて喋っている観測は、1つの区間に畳む**", () => {
  // 細切れのまま持つと、1秒の発言が10個の観測に割れて重なりが正しく測れない
  const spans = toSpeakingSpans(
    [
      { speaker: "丸山", at: 0 },
      { speaker: "丸山", at: 500 },
      { speaker: "丸山", at: 1000 },
    ],
    500,
  );

  expect(spans).toEqual([{ speaker: "丸山", from: 0, to: 1500 }]);
});

test("話者が変われば、区間も変わる", () => {
  const spans = toSpeakingSpans(
    [
      { speaker: "丸山", at: 0 },
      { speaker: "松本", at: 500 },
      { speaker: "丸山", at: 1000 },
    ],
    500,
  );

  expect(spans.map((s) => s.speaker)).toEqual(["丸山", "松本", "丸山"]);
});

test("間が空いたら、別の区間にする（黙っていた時間を喋っていたことにしない）", () => {
  const spans = toSpeakingSpans(
    [
      { speaker: "丸山", at: 0 },
      { speaker: "丸山", at: 10_000 },
    ],
    500,
  );

  expect(spans).toHaveLength(2);
});

test("誰も喋っていない観測は無視する", () => {
  expect(toSpeakingSpans([{ speaker: "  ", at: 0 }], 500)).toEqual([]);
});
