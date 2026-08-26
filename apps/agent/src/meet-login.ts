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
    permissions: [],
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
  } finally {
    // **必ず閉じる。** 掴んだままにすると、次に Bob が入れない
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[meet-login] 失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
