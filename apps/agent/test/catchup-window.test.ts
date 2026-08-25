/**
 * 留守明けにどこまで遡るか（#124）。env 不要。
 *
 * 既定は直近12時間。窓を切っているのは「起動のたびに何日も前のスレッドへ返信し始める」のを
 * 防ぐためで、そこは正しい。**壊れていたのは前提の方**——「基本的に動いている」を前提に
 * していたが、実際には4日間止まり、その間に来た呼びかけは一件も拾われなかった。
 *
 * ここで固めたいのは「遡れること」より、**遡り過ぎないこと**と、**遡ったと分かること**。
 */

import { catchupWindow, describeAway } from "@edv4h/russell-core";
import { expect, test } from "vitest";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const base = { now: NOW, windowMs: 12 * HOUR, maxAwayMs: 72 * HOUR };

/** 何時間前か（読みやすさのため）。 */
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

test("前回が分からなければ、既定の窓のまま（初回起動・記録が読めない）", () => {
  const w = catchupWindow({ ...base, lastSeenAt: undefined });

  expect(w.since).toEqual(hoursAgo(12));
  // 広げていないので、広げたことは言わない
  expect(w.awayMs).toBeUndefined();
  expect(w.capped).toBe(false);
});

test("普段の再起動では、何も変えない", () => {
  // 5分前まで動いていた＝留守にしていない
  const w = catchupWindow({ ...base, lastSeenAt: new Date(NOW.getTime() - 5 * 60 * 1000) });

  expect(w.since).toEqual(hoursAgo(12));
  expect(w.awayMs).toBeUndefined();
});

test("**留守にしていた分まで遡る**（12時間を超えて止まっていた）", () => {
  const w = catchupWindow({ ...base, lastSeenAt: hoursAgo(30) });

  // 既定の12時間ではなく、止まった時点まで
  expect(w.since).toEqual(hoursAgo(30));
  expect(w.awayMs).toBe(30 * HOUR);
  expect(w.capped).toBe(false);
});

test("**上限を超えたら打ち切る。打ち切ったことを伝える**", () => {
  // 実際に起きた形（4日間の停止）
  const w = catchupWindow({ ...base, lastSeenAt: hoursAgo(96) });

  // 上限が無いと、4日前の会話へ返信し始める
  expect(w.since).toEqual(hoursAgo(72));
  expect(w.awayMs).toBe(96 * HOUR);
  // **黙って切り詰めない。** 拾えなかった分があることは言える形にする
  expect(w.capped).toBe(true);
});

test("窓のちょうど境目では広げない（境界で行き来しない）", () => {
  const w = catchupWindow({ ...base, lastSeenAt: hoursAgo(12) });

  expect(w.since).toEqual(hoursAgo(12));
  expect(w.awayMs).toBeUndefined();
});

test("**未来の時刻は信じない**（時計がずれていても、全部は拾わない）", () => {
  // そのまま計算すると窓が負になり、すべてが「窓の中」になってしまう
  const w = catchupWindow({ ...base, lastSeenAt: new Date(NOW.getTime() + 10 * HOUR) });

  expect(w.since).toEqual(hoursAgo(12));
  expect(w.awayMs).toBeUndefined();
});

test("壊れた時刻も既定に倒す", () => {
  const w = catchupWindow({ ...base, lastSeenAt: new Date("なにか") });

  expect(w.since).toEqual(hoursAgo(12));
  expect(w.awayMs).toBeUndefined();
});

test("留守の長さは、人が読む形で言う", () => {
  expect(describeAway(30 * HOUR)).toBe("30時間");
  expect(describeAway(96 * HOUR)).toBe("4日");
});
