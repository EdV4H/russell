/**
 * ルーティンの実行判定（§5.1 dispatcher）。env 不要。
 *
 * 静的 cron を直接実行しない理由は復旧時の挙動にある。プロセスが3日止まっていたとき、
 * 溜まった分を全部やるのか、1回にまとめるのか、無かったことにするのかは**仕事の性質で違う**。
 * cron 自身はそれを決められない。
 */

import { leaseExpired, resolveCatchup } from "@edv4h/russell-core";
import { dueOccurrences } from "@edv4h/russell-plugin-routines-pg";
import { expect, test } from "vitest";

const d = (iso: string) => new Date(iso);
const missed = [d("2026-08-09T18:00:00Z"), d("2026-08-10T18:00:00Z"), d("2026-08-11T18:00:00Z")];

test("coalesce（既定）は最新の1回だけ — 復旧直後に連投しない", () => {
  expect(resolveCatchup({ missed })).toEqual([d("2026-08-11T18:00:00Z")]);
});

test("skip は何もしない", () => {
  expect(resolveCatchup({ missed, policy: "skip" })).toEqual([]);
});

test("replay_once は取りこぼした分を1回ずつ — 日付ごとに意味がある仕事向け", () => {
  expect(resolveCatchup({ missed, policy: "replay_once" })).toEqual(missed);
});

test("取りこぼしが無ければ何も実行しない", () => {
  expect(resolveCatchup({ missed: [] })).toEqual([]);
  expect(resolveCatchup({ missed: [], policy: "replay_once" })).toEqual([]);
});

test("heartbeat が途絶えたリースは引き取れる", () => {
  const now = d("2026-08-12T00:10:00Z");
  expect(leaseExpired(d("2026-08-12T00:09:00Z"), now, 10 * 60 * 1000)).toBe(false);
  expect(leaseExpired(d("2026-08-11T23:00:00Z"), now, 10 * 60 * 1000)).toBe(true);
  // 一度も heartbeat していない＝引き取ってよい
  expect(leaseExpired(null, now, 10 * 60 * 1000)).toBe(true);
});

// --- cron の解釈 ---

const routine = (over: Partial<Parameters<typeof dueOccurrences>[0]> = {}) => ({
  agentId: "bob",
  routineId: "journal",
  cron: "0 3 * * *", // 毎日 03:00
  timezone: "Asia/Tokyo",
  catchup: "replay_once" as const,
  lastScheduledFor: null,
  ...over,
});

test("初回は直前の1回だけ（登録した瞬間に過去分が湧かない）", () => {
  const due = dueOccurrences(routine(), d("2026-08-12T00:00:00Z"));
  expect(due).toHaveLength(1);
});

test("止まっていた分を replay_once で拾う", () => {
  // 8/9 03:00 JST まで実行済み → 8/12 09:00 JST 時点で 8/10・8/11・8/12 の3回分
  const due = dueOccurrences(
    routine({ lastScheduledFor: d("2026-08-08T18:00:00Z") }),
    d("2026-08-12T00:00:00Z"),
  );
  expect(due).toHaveLength(3);
});

test("同じ coalesce なら1回に畳む", () => {
  const due = dueOccurrences(
    routine({ catchup: "coalesce", lastScheduledFor: d("2026-08-08T18:00:00Z") }),
    d("2026-08-12T00:00:00Z"),
  );
  expect(due).toHaveLength(1);
});

test("タイムゾーンを見る（03:00 JST は前日 18:00 UTC）", () => {
  const due = dueOccurrences(
    routine({ lastScheduledFor: d("2026-08-10T18:00:00Z") }),
    d("2026-08-11T20:00:00Z"),
  );
  expect(due[0]?.toISOString()).toBe("2026-08-11T18:00:00.000Z");
});

test("実行済みの時刻は二度拾わない", () => {
  const due = dueOccurrences(
    routine({ lastScheduledFor: d("2026-08-11T18:00:00Z") }),
    d("2026-08-11T20:00:00Z"),
  );
  expect(due).toEqual([]);
});

test("cron が壊れているルーティンは走らせない（台帳の誤りは実行前に直す）", () => {
  expect(
    dueOccurrences(routine({ cron: "これは cron ではない" }), d("2026-08-12T00:00:00Z")),
  ).toEqual([]);
});

test("遡る上限がある（止まっていた期間が長いほど古い予定の価値は下がる）", () => {
  const due = dueOccurrences(
    routine({ lastScheduledFor: d("2026-01-01T00:00:00Z") }),
    d("2026-08-12T00:00:00Z"),
  );
  expect(due.length).toBeLessThanOrEqual(15); // 14日分 + 端数
});
