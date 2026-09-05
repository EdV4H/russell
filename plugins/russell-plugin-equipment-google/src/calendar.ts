/**
 * カレンダーを**読む**口（#130 の秘書役 Walter 向け）。
 *
 * 秘書の仕事は「予定と約束を落とさない」ことなので、まず**見えること**から始める。
 * 書き込み（作る・動かす）は `external_write` になり、しかも**他人の時間に触る**——
 * 承認の設計が要るので分けてある（§9.3 の段階的解放。Drive と Notion で通した順序）。
 *
 * 見える範囲は **Google 側の共有設定**がそのまま境界になる。その個体のアカウントに
 * 見えている予定だけが見える——**権限の説明が「共有したかどうか」で済む**。
 */

import type { SourceResult } from "@edv4h/russell-shared";
import type { FetchLike, GoogleAuth } from "./auth.js";

const CALENDAR = "https://www.googleapis.com/calendar/v3";

/** 予定1件。**誰と・いつ・何を**が落ちないようにする。 */
export interface CalendarEvent {
  id: string;
  title: string;
  /** 開始（ISO8601）。終日の予定は日付だけのことがある。 */
  start?: string;
  end?: string;
  /** 参加者の表示名かメール。**誰と会うか**は秘書の判断材料になる。 */
  attendees?: string[];
  /** 会議の URL（Meet 等）。 */
  conference?: string;
  url?: string;
}

export interface CalendarClientOptions {
  auth: GoogleAuth;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** 取れなかった。**理由の手がかりは残す**（本文は入れない, A1-5）。 */
const failed = (detail?: string): SourceResult<never> => ({
  status: "failed",
  freshness: new Date().toISOString(),
  ...(detail ? { detail } : {}),
});

/**
 * HTTP のステータスを、扱いの違う結果へ写す。
 *
 * **権限が無いのと、壊れているのは別。** 同じ `failed` に潰すと、
 * 「カレンダーを共有されていない」のか「トークンが切れた」のかが分からなくなる。
 */
const fromResponse = (res: Response): SourceResult<never> => ({
  status: res.status === 401 || res.status === 403 ? "unauthorized" : "failed",
  freshness: new Date().toISOString(),
  detail: `HTTP ${res.status}`,
});

/** 参加者を人が読む形に。**メールしか無ければメール**（当てにいかない）。 */
export function attendeeNames(
  attendees: { displayName?: string; email?: string; self?: boolean }[] | undefined,
): string[] {
  return (attendees ?? [])
    .filter((a) => a.self !== true) // 自分は数えない（「誰と会うか」を知りたい）
    .map((a) => a.displayName?.trim() || a.email?.trim() || "")
    .filter((name) => name !== "");
}

/**
 * 期間を決める。既定は**いまから7日**。
 *
 * 秘書が見たいのは「これから」であって履歴ではない。過去を既定に含めると、
 * 終わった予定について毎回喋り出す。
 */
export function rangeOf(
  input: { from?: string; days?: number },
  now: Date,
): { min: string; max: string } {
  const min = input.from ? new Date(input.from) : now;
  const start = Number.isNaN(min.getTime()) ? now : min;
  const days = Math.min(Math.max(input.days ?? 7, 1), 60);
  return {
    min: start.toISOString(),
    max: new Date(start.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export class CalendarClient {
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: CalendarClientOptions) {
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
   * これからの予定を並べる。
   *
   * **繰り返しの予定は展開する**（`singleEvents`）。展開しないと「毎週の定例」が
   * 1件に見えて、次がいつなのか分からない。
   */
  async upcoming(
    input: { from?: string; days?: number; query?: string; limit?: number },
    now = new Date(),
  ): Promise<SourceResult<CalendarEvent[]>> {
    const range = rangeOf(input, now);
    const params = new URLSearchParams({
      timeMin: range.min,
      timeMax: range.max,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(Math.max(input.limit ?? 20, 1), 100)),
    });
    const query = (input.query ?? "").trim();
    if (query !== "") params.set("q", query);

    const res = await this.request(`${CALENDAR}/calendars/primary/events?${params.toString()}`);
    // トークンが取れないのと、API が断るのは別物として返す
    if (!res) return failed("認証できませんでした");
    if (!res.ok) return fromResponse(res);

    const body = (await res.json()) as {
      items?: {
        id?: string;
        summary?: string;
        htmlLink?: string;
        hangoutLink?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        attendees?: { displayName?: string; email?: string; self?: boolean }[];
      }[];
    };
    const events = (body.items ?? [])
      .filter((e): e is { id: string } & typeof e => Boolean(e.id))
      .map((e) => ({
        id: e.id,
        // 件名が無い予定はある。**「無題」と書く**（空にすると一覧で消える）
        title: e.summary?.trim() || "（件名なし）",
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        attendees: attendeeNames(e.attendees),
        conference: e.hangoutLink,
        url: e.htmlLink,
      }));
    return { status: "complete", freshness: new Date().toISOString(), data: events };
  }
}
