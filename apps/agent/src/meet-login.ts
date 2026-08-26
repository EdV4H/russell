/**
 * 会議用プロファイルへのログイン（#130）。**人が一度だけ通す。**
 *
 * Google は自動化されたログインを弾くので、ここは人の手が要る。問題は
 * **どこにログインするか**だった。
 *
 * > [!IMPORTANT]
 * > **人が開く Chrome と、Bob が使うプロファイルを共有しない。**
 * > 手で `open -na "Google Chrome" --user-data-dir=…` すると、プロファイル選択画面が
 * > 出たり、ログインした先が Playwright の見る `Default` と食い違ったりする。
 * > しかも人がそのウィンドウを閉じ忘れるとプロファイルを掴んだままになり、
 * > Bob が入れない。実際にこの3つ全部で詰まった。
 * >
 * > だから**ログインも Playwright に開かせる**。そうすればセッションは、
 * > Bob が実際に使う場所へそのまま入る。掴みっぱなしにもならない（ここで閉じるので）。
 *
 *   pnpm --filter @edv4h/russell-agent meet-login
 */

import { createInterface } from "node:readline/promises";
import { chromium } from "playwright-core";

const PROFILE = process.env.RUSSELL_MEET_PROFILE;

async function main(): Promise<void> {
  if (!PROFILE) {
    console.error(
      "[meet-login] RUSSELL_MEET_PROFILE が未設定です。会議用プロファイルの置き場所を指定してください。",
    );
    process.exit(1);
  }

  console.log(`[meet-login] プロファイル: ${PROFILE}`);
  console.log(
    "[meet-login] ブラウザを開きます。**Bob 用の Google アカウント**でログインしてください。",
  );

  // 本番の参加と**同じ開き方**にする。ここが違うと、ログインした先も違う場所になる
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    // **本番と同じ開き方**（言語も含めて）。ここが違うと、設定した先も違う場所になる
    locale: "ja-JP",
    permissions: [],
    args: ["--lang=ja"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\nログインが終わったら Enter を押してください… ");
    rl.close();

    // **ログインできたかを、その場で確かめる。** 「やったつもり」で終わらせない
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded" });
    const url = page.url();
    if (url.includes("accounts.google.com") || url.includes("ServiceLogin")) {
      console.error("[meet-login] まだログインできていません（ログイン画面へ戻されました）。");
      process.exitCode = 1;
      return;
    }
    // 誰としてログインしているかを見せる。**招待する宛先を間違えないため**
    const who = await page
      .locator('[aria-label*="@"], a[aria-label*="@"]')
      .first()
      .getAttribute("aria-label")
      .catch(() => null);
    console.log(`[meet-login] ログインできています${who ? `: ${who}` : ""}`);
    console.log("[meet-login] このアカウントを、会議の招待にゲストとして追加してください。");

    // **字幕の言語は、この個体の設定である。** Meet はアカウントごとに覚えるので、
    // ここで一度決めておけば以後の会議に効く。英語のまま日本語を聞かせると
    // **英語として書き起こされる**（実際そうなった）ので、ここを通しておきたい。
    const meetingUrl = process.argv.slice(2).find((a) => a.startsWith("http"));
    if (meetingUrl) {
      console.log(`[meet-login] 会議を開きます: ${meetingUrl}`);
      console.log(
        "[meet-login] 字幕をオンにして、**字幕の言語を日本語**にしてください（一度で以後も効きます）。",
      );
      await page.goto(meetingUrl, { waitUntil: "domcontentloaded" });
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      await rl2.question("\n設定が終わったら Enter を押してください… ");
      rl2.close();
    } else {
      console.log(
        "[meet-login] 字幕の言語も決めるなら、会議の URL を渡して実行してください: meet-login <会議のURL>",
      );
    }
  } finally {
    // **必ず閉じる。** 掴んだままにすると、次に Bob が入れない
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[meet-login] 失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
