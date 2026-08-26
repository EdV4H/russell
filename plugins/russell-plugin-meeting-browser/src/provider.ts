/**
 * 会議に入る経路（ブラウザ, #130）。
 *
 * Meet Media API は採らなかった（**全参加者が Developer Preview に登録されている必要**があり、
 * 社外ゲストが1人いれば成立しない, #118）。代わりに、Bob 用の Google アカウントで
 * ブラウザから普通に参加する。
 *
 * > [!IMPORTANT]
 * > **ログインは人がやる。** Google は自動化されたログインを弾く。一度だけ人がブラウザで
 * > ログインしてプロファイルを作り、以降はそれを使い回す。プロファイルの場所は
 * > `RUSSELL_MEET_PROFILE`。無ければ**この経路は支給されない**（§9.2）。
 *
 * > [!IMPORTANT]
 * > **「入った」と「入れてもらえるのを待っている」を混ぜない。** Meet は参加を求めると
 * > ロビーで止まることがある。そこを「参加した」と言うと、**何も聞こえないまま
 * > 会議に出ているつもり**になる——黙って壊れる形なので、状態を分けて扱う。
 *
 * 文字起こしは**字幕**から取る。音声を受け取って自前で書き起こすより軽く、
 * 誰が喋ったかも字幕が持っている。字幕は自分の画面で ON にする（他の参加者には影響しない）。
 */

import type {
  MeetingProvider,
  MeetingSession,
  TranscriptLine,
} from "@edv4h/russell-plugin-meeting";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  type CaptionEntry,
  createCaptionState,
  drainCaptions,
  ingestCaptions,
} from "./captions.js";
import { clearStaleProfileLock } from "./profile-lock.js";

export interface BrowserMeetingOptions {
  /** ログイン済みのプロファイル。**人が一度作る**（無ければ支給されない）。 */
  profileDir?: string;
  /** 画面を出すか。既定は出す——**headless は Meet に弾かれることがある**。 */
  headless?: boolean;
  /** 字幕を見に行く間隔。 */
  pollMs?: number;
  /** 入れてもらえるのを待つ上限。**超えたら諦める**（ロビーで永遠に待たない）。 */
  admitTimeoutMs?: number;
  /** 試験用の差し替え口。実ブラウザを起動せずに経路を確かめる。 */
  launch?: (options: { profileDir: string; headless: boolean }) => Promise<BrowserContext>;
}

/**
 * ブラウザを開けなかった理由を、**人がやることが分かる形**に直す。
 *
 * Playwright の生の文言は長く、原因も埋もれている。いちばん多いのは
 * **プロファイルが使用中**——ログイン用に開いた Chrome を閉じ忘れているだけなのに、
 * 「会議に入れません」としか言われないと、リンクや権限を疑い始める（実際そうなった）。
 */
export function launchFailureReason(detail: string): string {
  const d = detail.toLowerCase();
  if (
    d.includes("processsingleton") ||
    d.includes("already in use") ||
    d.includes("singletonlock") ||
    d.includes("existing browser session")
  ) {
    return "ブラウザのプロファイルが使用中です。そのプロファイルで開いている Chrome を閉じてください";
  }
  // **`chrome` を含むだけで飛びつかない。** 初版はそうしていたので、無関係な失敗にまで
  // 「Chrome が見つかりません」と札を貼った——Chrome は標準の場所にあったのに、である。
  // 当てにいく条件は、**それしか意味しない文言**に限る。
  if (d.includes("executable doesn't exist") || d.includes("looks like playwright")) {
    return "Chrome が見つかりません（playwright-core は手元の Chrome を使います）";
  }
  return detail;
}

/** 参加の状態。**待っていることを、入ったことにしない。** */
export type JoinState = "joined" | "waiting" | "rejected" | "signed_out" | "unknown";

/** 入れなかったときに人がやること。**状態ごとに違う**ので、同じ文言にしない。 */
const JOIN_FAILURE: Record<JoinState, string> = {
  joined: "入れました",
  waiting: "ロビーで待たされたまま時間切れです（主催者に入室を許可してもらってください）",
  rejected: "参加を断られました（会議に招かれていないか、外部参加が制限されています）",
  unknown:
    "会議の画面を読めませんでした（URL が正しいか、ログインが切れていないか確かめてください）",
  // **「招かれていない」と取り違えない。** 直す場所がまるで違う（主催者ではなく、こちら）
  signed_out: "ブラウザのプロファイルがログインしていません（人が一度ログインし直してください）",
};

const DEFAULT_POLL_MS = 700;
const DEFAULT_ADMIT_TIMEOUT_MS = 2 * 60 * 1000;

/** 画面の文言から参加の状態を読む。**当てにいかず、分からなければ `unknown`。** */
/**
 * 参加ボタンの呼び名。**押さないと入れない。**
 *
 * 初版は URL を開くだけで「入った/入れない」を判定していた。Meet は開いた時点では
 * 準備画面で、`今すぐ参加` か `参加をリクエスト` を押して初めて中へ進む——
 * **押していないのだから、入れないのは当たり前だった。**
 */
const JOIN_BUTTONS = ["今すぐ参加", "参加をリクエスト", "Join now", "Ask to join", "参加"] as const;

/**
 * 準備画面なら参加を押す。**押せたかどうかを返す。**
 *
 * 押せなくても投げない——すでに中にいる、まだ描かれていない、のどちらもありうる。
 * 次の周期で見直せばよい。
 */
export async function clickJoin(page: Page): Promise<boolean> {
  for (const name of JOIN_BUTTONS) {
    const button = page.getByRole("button", { name, exact: false });
    try {
      if ((await button.count()) === 0) continue;
      await button.first().click({ timeout: 3000 });
      return true;
    } catch {
      // 押せなかった。別の呼び名を試す
    }
  }
  return false;
}

/**
 * ログインしていない兆候。**「招かれていない」と取り違えると、直す場所を間違える。**
 *
 * > [!IMPORTANT]
 * > **本文の「ログイン」で判断しない。** 初版はそうしていたが、Meet の「参加できません」
 * > 画面には「**別のアカウントでログイン**」のリンクが普通にある。つまり
 * > **招かれていないだけの画面を、未ログインと読む**。実際にそう誤判定した。
 * >
 * > 当てになるのは**行き先が変わったこと**（Google のログイン画面へ飛ばされる）で、
 * > これは他の意味を持たない。文言で見るのは、それ以外に読みようのないものだけ。
 */
export function looksSignedOut(url: string, text: string): boolean {
  if (url.includes("accounts.google.com") || url.includes("ServiceLogin")) return true;
  // 「ログインしてください」だけを見る。「〜でログイン」（別アカウントへの誘導）は含まない
  return /ログインしてください|sign in to continue/i.test(text);
}

export function readJoinState(text: string): JoinState {
  const t = text.toLowerCase();
  // 断られた（先に見る。待ちの文言と同時に出ることがある）
  if (t.includes("参加できません") || t.includes("denied") || t.includes("拒否")) return "rejected";
  if (t.includes("参加をリクエスト") || t.includes("asking to be let in") || t.includes("待機")) {
    return "waiting";
  }
  if (t.includes("会議を退出") || t.includes("leave call") || t.includes("字幕")) return "joined";
  return "unknown";
}

/**
 * 実ブラウザを開く。**playwright-core を使い、ブラウザは手元の Chrome を借りる**——
 * 自前で Chromium を落とすと、初回の導入とバージョン管理が増える。
 */
async function launchChrome(options: {
  profileDir: string;
  headless: boolean;
}): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  return await chromium.launchPersistentContext(options.profileDir, {
    channel: "chrome",
    headless: options.headless,
    // 会議に入るのでマイクとカメラを聞かれる。**どちらも渡さない**——
    // 聞くだけの参加なので、権限そのものを与えない方が事故が少ない
    permissions: [],
    args: ["--use-fake-ui-for-media-stream", "--mute-audio"],
  });
}

export function createBrowserMeetingProvider(
  options: BrowserMeetingOptions = {},
): MeetingProvider | undefined {
  const profileDir = options.profileDir ?? process.env.RUSSELL_MEET_PROFILE;
  if (!profileDir) {
    console.warn(
      "[meeting-browser] RUSSELL_MEET_PROFILE がありません。この経路は支給されません（人が一度ログインしてプロファイルを作ってください）。",
    );
    return undefined;
  }
  const headless = options.headless ?? false;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const admitTimeoutMs = options.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS;
  const launch = options.launch ?? launchChrome;
  const debug = process.env.RUSSELL_MEET_DEBUG === "1";

  return {
    id: "browser",
    async join(input: { url: string }): Promise<MeetingSession> {
      // **死んでいるロックは自分で片付ける。** このプロファイルは個体専用で、
      // 他に開く者はいない。人に毎回アクティビティモニタを見にいかせるのは筋が悪い。
      // 生きているなら消さない——**誰が持っているか**を言って、判断は人に渡す。
      const lock = clearStaleProfileLock(profileDir);
      if (lock.action === "cleared") {
        console.log(
          `[meeting-browser] 残っていたロックを片付けました（pid ${lock.pid}: ${lock.why}）`,
        );
      } else if (lock.action === "held") {
        throw new Error(
          `meeting-browser: プロファイルを別の Chrome が使っています（pid ${lock.pid}: ${lock.holder}）。それを終了してください`,
        );
      } else {
        console.log(`[meeting-browser] ロックの確認: ${lock.reason}`);
      }

      let context: BrowserContext;
      try {
        context = await launch({ profileDir, headless });
      } catch (err) {
        // **ブラウザが開けないことと、会議に入れないことは別**。人がやることが違う。
        //
        // **元のエラーを捨てない。** 見立てを添えるだけにする——初版は書き換えていたので、
        // 見立てが外れたときに**何が起きたのか誰にも分からなくなった**（実際そうなった）。
        const detail = err instanceof Error ? err.message : String(err);
        const hint = launchFailureReason(detail);
        const first = detail.split("\n")[0] ?? detail;
        throw new Error(
          hint === detail ? `meeting-browser: ${detail}` : `meeting-browser: ${hint}（${first}）`,
        );
      }
      const page = await context.newPage();
      let closed = false;
      /** 会議の名前。**入ってから読む**（取れなければ名乗らない）。 */
      let title: string | undefined;

      const shutdown = async () => {
        if (closed) return;
        closed = true;
        await context.close().catch(() => {});
      };

      try {
        await page.goto(input.url, { waitUntil: "domcontentloaded" });
        const state = await admit(page, admitTimeoutMs, pollMs, debug);
        if (state !== "joined") {
          // **入れていない。** ここで成功と言うと、何も聞こえないまま会議に出ているつもりになる
          await shutdown();
          throw new Error(`meeting-browser: ${JOIN_FAILURE[state]}`);
        }
        await enableCaptions(page);
        title = await meetingTitle(page);
      } catch (err) {
        await shutdown();
        throw err;
      }

      const handlers: ((line: TranscriptLine) => void)[] = [];
      const captions = createCaptionState();
      const timer = setInterval(() => {
        void (async () => {
          if (closed) return;
          let visible: CaptionEntry[];
          try {
            visible = await readCaptions(page);
          } catch {
            return; // 一時的に読めないことはある。**次の周期で拾い直す**
          }
          if (debug && visible.length > 0) {
            console.log(`[meeting-browser] 生の字幕: ${JSON.stringify(visible)}`);
          }
          for (const line of ingestCaptions(captions, visible, Date.now())) {
            for (const h of handlers) h(line);
          }
        })();
      }, pollMs);
      timer.unref?.();

      return {
        id: input.url,
        title,
        onLine(handler) {
          handlers.push(handler);
        },
        async leave() {
          clearInterval(timer);
          // **言い終わる前に出ることがある。** 溜まっている分を捨てない
          for (const line of drainCaptions(captions, Date.now())) {
            for (const h of handlers) h(line);
          }
          await shutdown();
        },
      };
    },
  };
}

/** 入れてもらえるまで待つ。**上限を超えたら諦める**（ロビーで永遠に待たない）。 */
async function admit(
  page: Page,
  timeoutMs: number,
  pollMs: number,
  debug = false,
): Promise<JoinState> {
  const deadline = Date.now() + timeoutMs;
  let last: JoinState = "unknown";
  let clicked = false;
  while (Date.now() < deadline) {
    const text = await page.innerText("body").catch(() => "");
    // **押さないと入れない。** 準備画面のうちに押す（一度だけ）
    if (!clicked) clicked = await clickJoin(page);
    // **ログインしていないなら、そう言う。** 「招かれていない」と取り違えると、
    // 主催者に許可を頼みにいくことになる——直す場所がまるで違う
    const state = looksSignedOut(page.url(), text) ? "signed_out" : readJoinState(text);
    // **判断の材料を捨てない。** 文言で状態を当てているので、外れたときに
    // 何を見てそう言ったのかが分からないと直せない（ここで何度も嵌っている）
    if (debug && state !== last) {
      console.log(
        `[meeting-browser] 画面: ${state} / ${page.url()} / 押した=${clicked} ← ${text.replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }
    last = state;
    // **記録してから抜ける。** 初版は signed_out をここより手前で返していたので、
    // 何を見てそう言ったのかが一切残らなかった（この失敗をここで繰り返した）
    if (last === "joined" || last === "rejected" || last === "signed_out") return last;
    await page.waitForTimeout(pollMs);
  }
  return last === "unknown" ? "unknown" : "waiting";
}

/**
 * 字幕を出す。**自分の画面だけの設定**なので、他の参加者には何も起きない。
 *
 * 押せなくても投げない——字幕が既に出ていることもある。**入っているのに落とす方が悪い。**
 */
async function enableCaptions(page: Page): Promise<void> {
  for (const name of ["字幕をオンにする", "Turn on captions"]) {
    const button = page.getByRole("button", { name });
    if (await button.count().catch(() => 0)) {
      await button
        .first()
        .click()
        .catch(() => {});
      return;
    }
  }
}

/**
 * 会議の名前を、**画面から**読む。
 *
 * Meet はタブのタイトルを `Meet – 〈会議名〉` の形にする。会議名が付いていない会議では
 * 会議コードがそのまま入るので、**それは名前ではない**として捨てる——
 * 「bmn-seom-nyu という会議」と言われても、人には何のことか分からない。
 *
 * 取れなければ `undefined`。**当てにいかない**（当てた名前は、当てたと分からない）。
 */
export function titleFromDocument(documentTitle: string): string | undefined {
  const raw = documentTitle.replace(/^meet\s*[–—-]\s*/i, "").trim();
  if (raw === "" || /^meet$/i.test(raw)) return undefined;
  // 会議コード（`abc-defg-hij`）だけなら、名前ではない
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(raw)) return undefined;
  return raw;
}

async function meetingTitle(page: Page): Promise<string | undefined> {
  try {
    return titleFromDocument(await page.title());
  } catch {
    return undefined;
  }
}

/** 画面に見えている字幕を読む。**取れなければ空**（読めないことを発言0件と混ぜない）。 */
async function readCaptions(page: Page): Promise<CaptionEntry[]> {
  return await page.evaluate(() => {
    const region = document.querySelector('[aria-label*="字幕"], [aria-label*="aptions"]');
    if (!region) return [];
    const out: { speaker: string; text: string }[] = [];
    for (const node of Array.from(region.querySelectorAll("div"))) {
      const speaker = node.querySelector("span")?.textContent?.trim() ?? "";
      const text = node.querySelector("div:last-child")?.textContent?.trim() ?? "";
      if (speaker && text) out.push({ speaker, text });
    }
    return out;
  });
}

export type { Browser, BrowserContext, Page };
