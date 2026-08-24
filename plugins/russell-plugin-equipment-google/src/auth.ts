/**
 * Google の認証（リフレッシュトークン → アクセストークン）。
 *
 * **個体ごとに違うのはアカウントであって、アプリではない。** クライアント ID と
 * シークレットは全個体で共有し、**リフレッシュトークンだけが個体ごと**に分かれる——
 * Google では身元がアカウント側にあるので、それで「Bob に共有されたものしか見えない」が成立する。
 * （Slack はアプリ自体が個体なので、あちらは個体ごとに別アプリになっている。形が違う。）
 */

/** テストで差し替えるための最小の口。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** 期限ぎりぎりで使わない。時計のずれと往復の時間を見込む。 */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export interface GoogleAuth {
  /** 使えるアクセストークン。取れなければ `undefined`（**当てずっぽうで投げない**）。 */
  token(): Promise<string | undefined>;
}

/**
 * アクセストークンを取り、期限まで使い回す。
 *
 * **失敗を投げない。** 装備の中で使うものなので、取れなければ道具側が `failed` を返して
 * 会話を続ける方がよい——認証の失敗で1ターンが落ちるのは割に合わない。
 */
export function createGoogleAuth(options: GoogleAuthOptions): GoogleAuth {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  let cached: { token: string; until: number } | undefined;

  return {
    async token(): Promise<string | undefined> {
      if (cached && now() < cached.until) return cached.token;
      try {
        const res = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            refresh_token: options.refreshToken,
            grant_type: "refresh_token",
          }).toString(),
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!body.access_token) return undefined;
        const ttl = (body.expires_in ?? 3600) * 1000;
        cached = { token: body.access_token, until: now() + ttl - EXPIRY_MARGIN_MS };
        return cached.token;
      } catch {
        return undefined;
      }
    },
  };
}
