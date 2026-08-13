/**
 * ビューアを外へ出すときの門番（#81）。
 *
 * ビューアは**記憶の本文がそのまま出る**（メモ・本棚・単語帳・個人カルテ・日記・監査ログ）。
 * これまでは `127.0.0.1` にしか待ち受けないことだけで守っていた。サーバーに置くなら
 * その前提が崩れる。
 *
 * ここが決めているのは**「運用者が見る」までの範囲**である。
 * **チーム全員に見せる話とは別**——そちらは「箱ごとに誰に見せるか」を決める必要があり
 * （個人カルテ・機微情報の印, ADR 0007/0008）、人の判断が要る。認証を付けても、
 * その問いは解けない。
 */

import { timingSafeEqual } from "node:crypto";

/** ループバックか。**ここに待ち受けている限り、外からは触れない**（従来の守り）。 */
export function isLoopback(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

export interface AccessConfig {
  host: string;
  token?: string;
}

/**
 * 起動してよいか。**外向きに待ち受けるのに合言葉が無いなら、起動しない**（fail-closed）。
 *
 * 「うっかり `0.0.0.0` にした」で記憶が全部出るのが、いちばんありそうな事故である。
 * 警告では防げない——動いてしまうので。
 */
export function checkStartup(config: AccessConfig): { ok: true } | { ok: false; reason: string } {
  if (isLoopback(config.host)) return { ok: true };
  if (!config.token) {
    return {
      ok: false,
      reason: `${config.host} に待ち受けようとしていますが、RUSSELL_VIEWER_TOKEN が設定されていません。
ビューアは記憶の本文をそのまま出すので、外向きに開く場合は合言葉が要ります。
（手元で見るだけなら RUSSELL_VIEWER_HOST を外してください。既定は 127.0.0.1 です）`,
    };
  }
  if (config.token.length < 16) {
    // 短い合言葉は総当たりで抜ける。**指定されているから安全、にしない**
    return { ok: false, reason: "RUSSELL_VIEWER_TOKEN が短すぎます（16文字以上）。" };
  }
  return { ok: true };
}

/** 合言葉の比較。**長さの違いも一定時間で扱う**（比較の速さから当てられないように）。 */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    // 長さが違っても同じだけ時間を使う（自分自身と比べる）
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export type Access =
  | { allowed: true; setCookie?: string }
  | { allowed: false; reason: "no_token" | "bad_token" };

/**
 * この要求を通してよいか。
 *
 * 合言葉が設定されていなければ素通し（ループバック限定で動いている従来の姿）。
 * 設定されていれば、`?token=` か Cookie を見る。**URL で渡された合言葉は Cookie へ移す**——
 * ブラウザで使う以上、毎回 URL に付けさせるとリンクや履歴に残り続ける。
 */
export function authorize(config: AccessConfig, input: { url: URL; cookie?: string }): Access {
  if (!config.token) return { allowed: true };

  const fromQuery = input.url.searchParams.get("token");
  if (fromQuery) {
    if (!sameToken(fromQuery, config.token)) return { allowed: false, reason: "bad_token" };
    // HttpOnly: 画面のスクリプトから読めない（記憶の本文が出るページなので）
    // SameSite=Lax: 他所のページから勝手に開かれても送られない
    return {
      allowed: true,
      setCookie: `russell_viewer=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,
    };
  }

  const cookie = parseCookie(input.cookie).russell_viewer;
  if (!cookie) return { allowed: false, reason: "no_token" };
  return sameToken(cookie, config.token)
    ? { allowed: true }
    : { allowed: false, reason: "bad_token" };
}

function parseCookie(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.split("=");
    if (!k || rest.length === 0) continue;
    out[k.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}
