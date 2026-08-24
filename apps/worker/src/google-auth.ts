/**
 * Google のリフレッシュトークンを取る（運用コマンド・1回だけ）。
 *
 *   pnpm --filter @edv4h/russell-worker google-auth
 *
 * ブラウザで同意すると、環境変数に貼る行が出る。
 *
 * > [!IMPORTANT]
 * > **同意する相手を間違えないこと。** ここで人のアカウントで同意すると、個体は
 * > 「その人として」Drive を読むことになる。**個体は個体のアカウントで**同意する。
 * > ブラウザに別のアカウントでログイン済みなら、切り替えてから進める。
 *
 * クライアント ID とシークレットは**全個体で共有**する（アプリの登録であって身元ではない）。
 * 個体ごとに違うのは、ここで取れるリフレッシュトークンだけ——Google では**身元がアカウント側**に
 * あるので、それで「その個体に共有されたものしか見えない」が成立する。
 * （Slack はアプリ自体が個体なので、あちらは個体ごとに別アプリ。形が違う。）
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** 読み取りだけ。**書き込みは要求しない**（要るようになったら、そのとき足す）。 */
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];
const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 8123);
const REDIRECT = `http://127.0.0.1:${PORT}`;

/** 受け取ったら閉じる、1回きりの窓口。 */
function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });

      if (error) {
        res.end("<p>同意されませんでした。ターミナルに戻ってください。</p>");
        server.close();
        reject(new Error(error));
        return;
      }
      // **state を確かめる。** 他所から投げ込まれた code を掴まないため
      if (!code || state !== expectedState) {
        res.end("<p>受け取れませんでした。ターミナルに戻ってください。</p>");
        return;
      }
      res.end("<p>受け取りました。ターミナルに戻ってください。</p>");
      server.close();
      resolve(code);
    });
    server.listen(PORT, "127.0.0.1");
    server.on("error", reject);
  });
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "[google-auth] GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してから実行してください。",
    );
    process.exit(1);
  }

  const state = randomBytes(16).toString("hex");
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    // **同意画面を必ず出す。** 出さないと、既に同意済みのときにリフレッシュトークンが
    // 返らない（「成功したのに空」という、いちばん分かりにくい失敗になる）
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString()}`;

  console.log("次の URL をブラウザで開いて、**その個体のアカウントで**同意してください:\n");
  console.log(authUrl);
  console.log("\n（別のアカウントでログイン済みなら、切り替えてから進めてください）\n");

  const code = await waitForCode(state);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    }).toString(),
  });
  if (!res.ok) {
    console.error(`[google-auth] 交換に失敗しました: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = (await res.json()) as { refresh_token?: string; scope?: string };
  if (!body.refresh_token) {
    // **黙って終わらない。** 取れなかったことに気づかないまま設定を書くと、後で謎の失敗になる
    console.error(
      "[google-auth] リフレッシュトークンが返りませんでした。既に同意済みの可能性があります。" +
        "\nhttps://myaccount.google.com/permissions からこのアプリの許可を外して、もう一度実行してください。",
    );
    process.exit(1);
  }

  console.log("\n=== 設定に足してください ===");
  console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}`);
  console.log("\n許可されたスコープ:", body.scope ?? "(不明)");
}

main().catch((err) => {
  console.error("[google-auth] 失敗:", err instanceof Error ? err.message : err);
  process.exit(1);
});
