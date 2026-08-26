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
    // **日本語で聞かせる。** 字幕の言語は Meet 側の設定だが、既定はブラウザの言語に
    // 引きずられる。英語のまま日本語を聞かせると、**英語として書き起こされる**
    // （実際そうなった）。ここを揃えておくと、少なくとも初期値が日本語側に寄る。
    locale: "ja-JP",
    // 会議に入るのでマイクとカメラを聞かれる。**どちらも渡さない**——
    // 聞くだけの参加なので、権限そのものを与えない方が事故が少ない
    permissions: [],
    args: ["--use-fake-ui-for-media-stream", "--mute-audio", "--lang=ja"],
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
        const captionState = await enableCaptions(page);
        console.log(`[meeting-browser] 字幕: ${captionState}`);
        title = await meetingTitle(page);
      } catch (err) {
        await shutdown();
        throw err;
      }

      const handlers: ((line: TranscriptLine) => void)[] = [];
      const captions = createCaptionState();
      /** 枠が無いことを言ったか。**毎周期は騒がしい**ので一度だけ。 */
      let warnedNoRegion = false;
      /** DOM を出す残り回数。**数回で足りる**（毎周期出すとログが埋まる）。 */
      let probesLeft = debug ? 6 : 0;
      /** 前回見えていた文字。**変わったところ**を見つけるための控え。 */
      let previousTexts: Record<string, string> = {};
      const timer = setInterval(() => {
        void (async () => {
          if (closed) return;
          let seen: { region: boolean; entries: CaptionEntry[] };
          try {
            seen = await readCaptions(page);
          } catch {
            return; // 一時的に読めないことはある。**次の周期で拾い直す**
          }
          // **枠が見つからないことを、黙って0件にしない。** 一度だけ言う（毎周期は騒がしい）
          if (!seen.region && !warnedNoRegion) {
            warnedNoRegion = true;
            console.warn(
              "[meeting-browser] 字幕の枠が見つかりません（字幕が出ていないか、探し方が違います）",
            );
          }
          if (seen.region) warnedNoRegion = false;
          if (debug && seen.entries.length > 0) {
            console.log(`[meeting-browser] 生の字幕: ${JSON.stringify(seen.entries)}`);
          }
          // **構造を先に見る。** 取れた／取れないに関わらず数回出す——
          // 「取れているが中身が違う」を、取れたことにして見逃さないため
          if (debug && probesLeft > 0) {
            const now = await snapshotTexts(page).catch(() => ({}));
            const changes = changedTexts(previousTexts, now).filter(
              // 時計や状態のお知らせなど、喋らなくても変わるものを弾く
              (c) => !/\d{1,2}:\d{2}|カメラはオフ|マイクはオフ|自動字幕起こし/.test(c),
            );
            previousTexts = now;
            if (changes.length > 0) {
              probesLeft--;
              console.log(
                `[meeting-browser] 変わったところ:\n  ${changes.slice(0, 8).join("\n  ")}`,
              );
            }
          }
          for (const line of ingestCaptions(captions, seen.entries, Date.now())) {
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

/** 字幕のボタンの呼び名。Meet は表記が揺れるので、いくつか試す。 */
const CAPTION_BUTTONS = [
  "字幕をオンにする",
  "字幕を表示",
  "Turn on captions",
  "字幕",
  "captions",
] as const;

/**
 * 字幕を出す。**自分の画面だけの設定**なので、他の参加者には何も起きない。
 *
 * 押せなくても投げない——字幕が既に出ていることもある。**入っているのに落とす方が悪い。**
 * ただし**押せたかどうかは返す**。字幕が一件も来ないときに、
 * 「誰も喋っていない」のか「そもそも字幕を出せていない」のかが分かれる。
 */
async function enableCaptions(page: Page): Promise<string> {
  for (const name of CAPTION_BUTTONS) {
    const button = page.getByRole("button", { name, exact: false });
    try {
      if ((await button.count()) === 0) continue;
      await button.first().click({ timeout: 3000 });
      return `押した（${name}）`;
    } catch {
      // 別の呼び名を試す
    }
  }
  // ボタンが見つからない。**Meet のショートカット**で試す（`c` が字幕の切り替え）
  try {
    await page.keyboard.press("c");
    return "ショートカット c を押した（ボタンが見つからなかった）";
  } catch {
    return "字幕を出せなかった";
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

/**
 * 画面に見えている字幕を読む。
 *
 * > [!IMPORTANT]
 * > **「枠が無い」と「誰も喋っていない」を分ける。** 両方を空配列で返していたので、
 * > 字幕が一件も来ないときに**どちらなのか分からなかった**（実際そうなった）。
 * > 前者は直せる問題（字幕が出ていない・探し方が違う）で、後者は正常である。
 */
async function readCaptions(page: Page): Promise<{ region: boolean; entries: CaptionEntry[] }> {
  return await page.evaluate(() => {
    // **実物の構造**（2026-08-26 に確認）:
    //   SPAN.NWpY1d        … 話者の名前
    //   DIV.ygicle.VbkSUe  … 本文（喋るあいだ伸びていく／途中で言い直される）
    //
    // class 名は難読化されていて**いつか変わる**。だから名前は手がかりに留め、
    // 見つからなければ**形**で探す（名前の span と、それより長い本文の div が
    // 同じ入れ物にいる）。壊れたときに黙って0件にならないことの方が大事である。
    const byName = Array.from(document.querySelectorAll('div[class*="ygicle"]'));
    const byShape = byName.length > 0 ? [] : findByShape();

    function findByShape(): Element[] {
      const found: Element[] = [];
      for (const el of Array.from(document.querySelectorAll("div"))) {
        if (el.querySelector("div")) continue; // 葉だけを見る
        const text = (el.textContent ?? "").trim();
        if (text.length < 2 || text.length > 400) continue;
        const holder = el.parentElement?.parentElement;
        const name = holder?.querySelector("span")?.textContent?.trim() ?? "";
        // 名前は短く、本文はそれより長い。ボタンの並びはここで落ちる
        if (name.length >= 1 && name.length <= 40 && text.length > name.length) found.push(el);
      }
      return found;
    }

    const nodes = byName.length > 0 ? byName : byShape;
    if (nodes.length === 0) return { region: false, entries: [] };

    const out: { speaker: string; text: string }[] = [];
    for (const node of nodes) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text === "") continue;
      // 名前は同じ入れ物の中にある。近いところから順に探す
      let speaker = "";
      let holder: Element | null = node.parentElement;
      for (let i = 0; i < 3 && holder && speaker === ""; i++) {
        speaker = holder.querySelector("span")?.textContent?.trim() ?? "";
        holder = holder.parentElement;
      }
      if (speaker === "" || speaker === text) continue;
      out.push({ speaker, text });
    }
    return { region: true, entries: out };
  });
}

/**
 * 字幕の枠を**振る舞いで**探す（`RUSSELL_MEET_DEBUG=1` のとき）。
 *
 * > [!IMPORTANT]
 * > **属性で当てにいくのは3回失敗した。** `aria-label` はボタンに当たり、`role="region"` は
 * > ツールバーに当たり、`aria-live` は読み上げ用のお知らせ（「カメラはオフになっています」）
 * > に当たった。Meet の DOM はこちらの仕様ではないので、名前で当てにいく限り外し続ける。
 * >
 * > **字幕は、人が喋るたびに変わる唯一の場所である。** だから「変わったところ」を探す。
 * > これは名前に依存しないので、画面の作りが変わっても効く。
 */
async function snapshotTexts(page: Page): Promise<Record<string, string>> {
  return await page.evaluate(() => {
    const out: Record<string, string> = {};
    let index = 0;
    for (const el of Array.from(document.querySelectorAll("div,span,p"))) {
      // 子を持たない（＝実際に文字を持つ）ところだけを見る。親は子の変化を写すだけ
      if (el.querySelector("div,span,p")) continue;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length < 2 || text.length > 300) continue;
      const attrs = ["jsname", "class", "aria-label"]
        .map((n) => el.getAttribute(n))
        .filter(Boolean)
        .join("|")
        .slice(0, 60);
      out[`${el.tagName}#${attrs || "無属性"}#${index++}`] = text;
    }
    return out;
  });
}

/** 前回から**変わったところ**だけを返す。常に変わるもの（時計など）は呼び出し側で弾く。 */
export function changedTexts(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changes: string[] = [];
  for (const [key, text] of Object.entries(after)) {
    if (before[key] === text) continue;
    changes.push(`${key} :: ${text.slice(0, 120)}`);
  }
  return changes;
}

export type { Browser, BrowserContext, Page };
