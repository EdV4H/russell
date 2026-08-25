/**
 * 会議に入る経路（ブラウザ, #130）。実ブラウザは起動しない（偽の context を渡す）。
 *
 * ここで固めたいのは「入れること」より、**入れていないときに入ったと言わないこと**。
 * Meet はロビーで止まることがあり、そこを参加扱いにすると
 * **何も聞こえないまま会議に出ているつもり**になる——黙って壊れる形である。
 */

import { createBrowserMeetingProvider, readJoinState } from "@edv4h/russell-plugin-meeting-browser";
import { expect, test } from "vitest";

test("画面の文言から参加の状態を読む", () => {
  expect(readJoinState("会議を退出 字幕をオンにする")).toBe("joined");
  expect(readJoinState("参加をリクエストしています")).toBe("waiting");
  expect(readJoinState("Asking to be let in")).toBe("waiting");
  expect(readJoinState("会議に参加できません")).toBe("rejected");
  // **当てにいかない。** 読めない画面を「入れた」に倒すと、黙って壊れる
  expect(readJoinState("読み込み中")).toBe("unknown");
});

test("**断られたことを、待っていることと混ぜない**（人がやることが違う）", () => {
  // 待ちなら入れてもらえばよい。断られたなら、そもそも呼ばれていない
  expect(readJoinState("参加をリクエスト 会議に参加できません")).toBe("rejected");
});

/** 画面の見え方だけを決められる、偽のブラウザ。 */
function fakeBrowser(bodyText: string) {
  let closed = false;
  const context = {
    async newPage() {
      return {
        async goto() {},
        async innerText() {
          return bodyText;
        },
        async waitForTimeout() {},
        getByRole() {
          return {
            async count() {
              return 0;
            },
          };
        },
        async evaluate() {
          return [];
        },
      };
    },
    async close() {
      closed = true;
    },
  };
  return { context, isClosed: () => closed };
}

const provider = (bodyText: string, browser = fakeBrowser(bodyText)) => ({
  browser,
  instance: createBrowserMeetingProvider({
    profileDir: "/tmp/profile",
    admitTimeoutMs: 50,
    pollMs: 5,
    // biome-ignore lint/suspicious/noExplicitAny: 画面の見え方だけを差し替えた偽物
    launch: async () => browser.context as any,
  }),
});

test("**認証情報が無ければ、この経路そのものが無い**（未支給, §9.2）", () => {
  const saved = process.env.RUSSELL_MEET_PROFILE;
  process.env.RUSSELL_MEET_PROFILE = undefined as unknown as string;
  // biome-ignore lint/performance/noDelete: env から本当に消す必要がある
  delete process.env.RUSSELL_MEET_PROFILE;

  expect(createBrowserMeetingProvider()).toBeUndefined();

  if (saved !== undefined) process.env.RUSSELL_MEET_PROFILE = saved;
});

test("入れたら、会議として扱える", async () => {
  const { instance } = provider("会議を退出 字幕");
  const session = await instance?.join({ url: "https://meet.google.com/abc-defg-hij" });

  expect(session?.id).toBe("https://meet.google.com/abc-defg-hij");
  await session?.leave();
});

test("**ロビーで待たされたまま上限に達したら、入れたと言わない**", async () => {
  const { instance, browser } = provider("参加をリクエストしています");

  await expect(instance?.join({ url: "https://meet.google.com/abc" })).rejects.toThrow(/waiting/);
  // 入れなかったのにブラウザを掴んだままにしない
  expect(browser.isClosed()).toBe(true);
});

test("断られたら、待たずに諦める", async () => {
  const { instance, browser } = provider("会議に参加できません");

  await expect(instance?.join({ url: "https://meet.google.com/abc" })).rejects.toThrow(/rejected/);
  expect(browser.isClosed()).toBe(true);
});

test("**画面が読めないときも、入れたことにしない**", async () => {
  const { instance } = provider("読み込み中");

  await expect(instance?.join({ url: "https://meet.google.com/abc" })).rejects.toThrow(/unknown/);
});

test("出たらブラウザを閉じる（掴んだまま残さない）", async () => {
  const browser = fakeBrowser("会議を退出 字幕");
  const { instance } = provider("会議を退出 字幕", browser);
  const session = await instance?.join({ url: "https://meet.google.com/abc" });

  await session?.leave();
  expect(browser.isClosed()).toBe(true);
  // 二度呼んでも壊れない（退出は止める方向の行為なので、通しておきたい）
  await session?.leave();
});
