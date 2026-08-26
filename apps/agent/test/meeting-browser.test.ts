/**
 * 会議に入る経路（ブラウザ, #130）。実ブラウザは起動しない（偽の context を渡す）。
 *
 * ここで固めたいのは「入れること」より、**入れていないときに入ったと言わないこと**。
 * Meet はロビーで止まることがあり、そこを参加扱いにすると
 * **何も聞こえないまま会議に出ているつもり**になる——黙って壊れる形である。
 */

import {
  createBrowserMeetingProvider,
  launchFailureReason,
  looksSignedOut,
  readJoinState,
  titleFromDocument,
} from "@edv4h/russell-plugin-meeting-browser";
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
        url: () => "https://meet.google.com/abc",
        async title() {
          return "Meet";
        },
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

  await expect(instance?.join({ url: "https://meet.google.com/abc" })).rejects.toThrow(/ロビー/);
  // 入れなかったのにブラウザを掴んだままにしない
  expect(browser.isClosed()).toBe(true);
});

test("断られたら、待たずに諦める", async () => {
  const { instance, browser } = provider("会議に参加できません");

  await expect(instance?.join({ url: "https://meet.google.com/abc" })).rejects.toThrow(
    /断られました/,
  );
  expect(browser.isClosed()).toBe(true);
});

test("**画面が読めないときも、入れたことにしない**", async () => {
  const { instance } = provider("読み込み中");

  await expect(instance?.join({ url: "https://meet.google.com/abc" })).rejects.toThrow(
    /読めませんでした/,
  );
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

/**
 * 入れなかったときに何と言うか。
 *
 * 実際に一度、理由を握り潰したまま「入れませんでした」とだけ返した。すると個体は
 * **推測で理由を作った**——「リンクが期限切れかもしれません」。そんなことは分かっていない。
 * 原因の手がかりは本文ではないので、そのまま渡してよい（A1-5）。
 */

test("**ブラウザが開けない理由を、人がやることが分かる形にする**", () => {
  // いちばん多いのはこれ。ログイン用に開いた Chrome を閉じ忘れているだけ
  expect(launchFailureReason("ProcessSingleton: profile is already in use")).toContain("閉じて");
  expect(launchFailureReason("Failed to create SingletonLock")).toContain("閉じて");
  expect(launchFailureReason("Chromium executable doesn't exist")).toContain("Chrome");
  // 知らない失敗は、そのまま渡す（黙って「不明」に潰さない）
  expect(launchFailureReason("socket hang up")).toBe("socket hang up");
});

test("**`chrome` を含むだけで「見つかりません」と言わない**", () => {
  // 初版は `chrome` を含めば飛びついたので、無関係な失敗にまで札を貼った——
  // Chrome は標準の場所にあったのに、**環境の問題だと報告した**
  const unrelated = "Target page, context or browser has been closed (chrome)";
  expect(launchFailureReason(unrelated)).toBe(unrelated);
  // 「見つからない」としか読めない文言のときだけ、そう言う
  expect(launchFailureReason("Executable doesn't exist at /Applications/…")).toContain("Chrome");
});

test("**見立てを添えても、元のエラーは残す**", async () => {
  const browser = fakeBrowser("");
  browser.context.newPage = async () => {
    throw new Error("never");
  };
  const instance = createBrowserMeetingProvider({
    profileDir: "/tmp/profile",
    launch: async () => {
      throw new Error("ProcessSingleton failed: profile is already in use\n詳しい行");
    },
  });

  // 見立て（閉じてください）と、元の文言の両方が出る。**外れたときに追えなくなる**
  await expect(instance?.join({ url: "https://meet.google.com/a" })).rejects.toThrow(/閉じて/);
  await expect(instance?.join({ url: "https://meet.google.com/a" })).rejects.toThrow(
    /ProcessSingleton/,
  );
});

test("待ち・拒否・不明で、言うことが変わる（人がやることが違う）", async () => {
  const waiting = provider("参加をリクエストしています");
  await expect(waiting.instance?.join({ url: "https://meet.google.com/a" })).rejects.toThrow(
    /主催者/,
  );

  const rejected = provider("会議に参加できません");
  await expect(rejected.instance?.join({ url: "https://meet.google.com/a" })).rejects.toThrow(
    /招かれていない|制限/,
  );

  const unknown = provider("読み込み中");
  await expect(unknown.instance?.join({ url: "https://meet.google.com/a" })).rejects.toThrow(
    /URL|ログイン/,
  );
});

/**
 * 会議の名前は、**入ってから画面で分かる**もの。
 *
 * 以前は参加を頼む側（モデル）に名乗らせていた。入る前に会議名を知る手段は無いので、
 * そこに入るのは作り話である——URL の会議コードや、会話から推測した名前が毎回入り、
 * **それが承認画面の見出しになっていた**。押す人はその名前を見て判断する。
 */

test("**タブのタイトルから会議名を取る**", () => {
  expect(titleFromDocument("Meet – 定例ミーティング")).toBe("定例ミーティング");
  expect(titleFromDocument("Meet - Weekly Sync")).toBe("Weekly Sync");
});

test("**会議コードは名前ではない**（人に伝わらない）", () => {
  // 「bmn-seom-nyu という会議」と言われても、何のことか分からない
  expect(titleFromDocument("Meet – bmn-seom-nyu")).toBeUndefined();
  expect(titleFromDocument("Meet")).toBeUndefined();
  expect(titleFromDocument("")).toBeUndefined();
});

/**
 * **押さないと入れない。**
 *
 * 初版は URL を開くだけで「入った／入れない」を判定していた。Meet は開いた時点では
 * 準備画面で、`今すぐ参加` か `参加をリクエスト` を押して初めて中へ進む——
 * 押していないのだから、入れないのは当たり前だった。しかも判定が即座に走るので、
 * **Chrome が開いて一瞬で閉じ、人が承認する間もなかった**。
 */

test("**ログインしていないことを、招かれていないことと混ぜない**", () => {
  // 直す場所がまるで違う（主催者に頼むのか、こちらでログインし直すのか）
  expect(looksSignedOut("https://accounts.google.com/ServiceLogin", "")).toBe(true);
  expect(looksSignedOut("https://meet.google.com/abc", "ログインしてください")).toBe(true);
  expect(looksSignedOut("https://meet.google.com/abc", "Sign in to continue")).toBe(true);
  // 会議の画面はログイン済み
  expect(looksSignedOut("https://meet.google.com/abc", "会議を退出 字幕")).toBe(false);
});
