/**
 * Drive とドキュメントを読む口。**読み取りだけ。**
 *
 * 見える範囲は **Google 側の共有設定**がそのまま境界になる（Notion の統合と同じ考え方）。
 * Bob に共有されていないものは、探しても出てこない——**権限の説明が「共有したかどうか」で済む**。
 */

import type { SourceResult } from "@edv4h/russell-shared";
import type { FetchLike, GoogleAuth } from "./auth.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
/** Google ドキュメント。会議の文字起こしもこの形で保存される。 */
const DOC_MIME = "application/vnd.google-apps.document";

/** どうやって当たったか。名前で出なかったことは、**人に伝える価値がある**。 */
export type DriveMatch = "name" | "text";

export interface DriveFile {
  id: string;
  name: string;
  /** 最終更新（ISO8601）。**どれが新しいか**が分からないと選べない。 */
  modifiedAt?: string;
  url?: string;
  /** 名前で当たったのか、本文で当たったのか。 */
  matchedBy?: DriveMatch;
}

export interface DriveDocument extends DriveFile {
  text: string;
}

export interface GoogleClientOptions {
  auth: GoogleAuth;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** 探すときに使う語を、Drive の検索式へ入れられる形にする。 */
function escapeQuery(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * 渡されたものからファイル ID を取り出す。**人は URL を貼る。**
 *
 * 「これ読んで」と URL を貼るのが自然な渡し方で、ID だけを抜いて渡せというのは
 * 道具の都合である。両方受けて、こちらで吸収する。
 */
export function fileIdFrom(input: string): string {
  const text = input.trim();
  // https://docs.google.com/document/d/<id>/edit / https://drive.google.com/file/d/<id>/view
  const path = text.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (path?.[1]) return path[1];
  // https://drive.google.com/open?id=<id>
  const query = text.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (query?.[1]) return query[1];
  // URL でなければ、そのまま ID として扱う
  return text;
}

/**
 * HTTP のステータスを、扱いの違う結果へ写す。
 *
 * **権限が無いのと、壊れているのは別**。同じ `failed` に潰すと、
 * 「共有されていない」のか「トークンが切れた」のかが分からなくなる。
 */
function statusFor(httpStatus: number): SourceResult["status"] {
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  return "failed";
}

/** 取れなかった。**理由の手がかりは残す**（本文は入れない）。 */
const failed = (detail?: string): SourceResult<never> => ({
  status: "failed",
  freshness: new Date().toISOString(),
  ...(detail ? { detail } : {}),
});

const fromResponse = (res: Response): SourceResult<never> => ({
  status: statusFor(res.status),
  freshness: new Date().toISOString(),
  detail: `HTTP ${res.status}`,
});

/** どちらで当たったかを結果に残す。**これが無いと「無い」と「名前に無い」が同じに見える。** */
const stamp = (
  result: SourceResult<DriveFile[]>,
  matchedBy: DriveMatch,
): SourceResult<DriveFile[]> => ({
  ...result,
  data: (result.data ?? []).map((f) => ({ ...f, matchedBy })),
});

export class GoogleClient {
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GoogleClientOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(url: string): Promise<Response | undefined> {
    const token = await this.auth.token();
    if (!token) return undefined; // 認証できない。**空の結果と区別する**ために undefined
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 共有されている Google ドキュメントを探す。**名前で当て、駄目なら本文へ降りる。**
   *
   * 最初は名前だけで引いていた。理由があって——全文検索は**会議の文字起こしに当たりすぎる**。
   * 本文が長いので、「先週の定例」を探したいのに雑談で同じ語が出た別の文書が並ぶ。
   *
   * ただし実際に使ってみると、**名前だけでは取りこぼした**。議事録の名前は
   * 「Meet: 〈会議名〉 - 日付 - Gemini によるメモ」のように機械が付けるので、
   * 人が覚えている呼び名とは一致しない。
   *
   * そこで順番を付けた。**名前で1件でも出たらそれを返す**（当たりすぎの弊害はここで止まる）。
   * 0件のときだけ本文で引き直す。どちらで当たったかは `matchedBy` に残す——
   * 「名前では出ませんでしたが、本文に出てきます」と言えるかどうかで、人の納得が変わる。
   */
  async search(query: string, limit = 5): Promise<SourceResult<DriveFile[]>> {
    const term = escapeQuery(query);

    const byName = await this.find(`name contains '${term}'`, limit);
    if (byName.status !== "complete") return byName; // 探せなかった。0件と言わない
    if (byName.data && byName.data.length > 0) return stamp(byName, "name");

    // 名前では出なかった。**ここで初めて本文を見る。**
    const byText = await this.find(`fullText contains '${term}'`, limit);
    if (byText.status !== "complete") {
      // 名前は 0件と言い切れるが、本文は確かめられていない。**全部を見たとは言わない**
      return {
        status: "partial",
        freshness: new Date().toISOString(),
        detail: `名前では0件。本文での探し直しに失敗しました（${byText.detail ?? "理由不明"}）`,
        data: [],
      };
    }
    return stamp(byText, "text");
  }

  /** 検索式ひとつ分。ここは条件が違うだけで、あとは同じ。 */
  private async find(condition: string, limit: number): Promise<SourceResult<DriveFile[]>> {
    const q = [condition, `mimeType = '${DOC_MIME}'`, "trashed = false"].join(" and ");
    const params = new URLSearchParams({
      q,
      pageSize: String(Math.min(Math.max(limit, 1), 20)),
      // 新しいものから。**どれが最近の会議か**が分からないと選べない
      orderBy: "modifiedTime desc",
      fields: "files(id,name,modifiedTime,webViewLink)",
      // 共有ドライブに置かれた文書も対象にする（チームで使う置き場はたいていこちら）
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });

    const res = await this.request(`${DRIVE}/files?${params.toString()}`);
    // トークンが取れないのと、API が断るのは別物として返す
    if (!res) return failed("認証できませんでした");
    if (!res.ok) return fromResponse(res);
    const body = (await res.json()) as {
      files?: { id?: string; name?: string; modifiedTime?: string; webViewLink?: string }[];
    };
    const files = (body.files ?? [])
      .filter((f): f is { id: string; name: string } & typeof f => Boolean(f.id && f.name))
      .map((f) => ({ id: f.id, name: f.name, modifiedAt: f.modifiedTime, url: f.webViewLink }));
    return { status: "complete", freshness: new Date().toISOString(), data: files };
  }

  /**
   * ドキュメント1件を本文つきで読む。
   *
   * 本文は Drive の**書き出し**（`export`）で取る。ドキュメント API を使うと段落や表の構造を
   * 自分で組み立て直すことになり、**読むだけの用途には重い**。
   */
  async read(fileId: string): Promise<SourceResult<DriveDocument>> {
    const metaParams = new URLSearchParams({
      fields: "id,name,modifiedTime,webViewLink",
      supportsAllDrives: "true",
    });
    const metaUrl = `${DRIVE}/files/${encodeURIComponent(fileId)}?${metaParams.toString()}`;
    const meta = await this.request(metaUrl);
    if (!meta) return failed("認証できませんでした");
    if (!meta.ok) return fromResponse(meta);
    const file = (await meta.json()) as {
      id?: string;
      name?: string;
      modifiedTime?: string;
      webViewLink?: string;
    };

    const body = await this.request(
      `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
    );
    // 見出しは取れたが本文が読めなかった＝**部分的に取れた**。空の本文を complete と言わない
    if (!body || !body.ok) {
      return {
        status: "partial",
        freshness: new Date().toISOString(),
        detail: body ? `本文が読めません（HTTP ${body.status}）` : "認証できませんでした",
        data: {
          id: file.id ?? fileId,
          name: file.name ?? "",
          modifiedAt: file.modifiedTime,
          url: file.webViewLink,
          text: "",
        },
      };
    }
    return {
      status: "complete",
      freshness: new Date().toISOString(),
      data: {
        id: file.id ?? fileId,
        name: file.name ?? "",
        modifiedAt: file.modifiedTime,
        url: file.webViewLink,
        text: await body.text(),
      },
    };
  }
}
