/**
 * 装備（§9）: Google カレンダーを**読む**。
 *
 * 秘書役（Walter）の最初の装備。**読み取りしか持たない**——予定を作る・動かすのは
 * `external_write` であり、しかも**他人の時間に触る**。承認の設計が要るので分けてある
 * （§9.3 の段階的解放。Drive と Notion で通した順序と同じ）。
 *
 * 認証は Drive の装備と同じ仕組みを使う（同じ OAuth クライアント、**個体ごとの
 * リフレッシュトークン**）。ただし**スコープが違う**——カレンダー用に取り直しが要る。
 */

import type { AgentContext, RussellPlugin, SourceResult } from "@edv4h/russell-shared";
import { type FetchLike, createGoogleAuth } from "./auth.js";
import { CalendarClient, type CalendarEvent } from "./calendar.js";

export interface CalendarEquipmentOptions {
  clientId?: string;
  clientSecret?: string;
  /** **個体ごと**の鍵。これが「誰のカレンダーを見るか」を決める。 */
  refreshToken?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** ツールの戻り値。**中身は必ず untrusted**（他者が書いた予定, §12-3）。 */
export interface CalendarToolResult<T> extends SourceResult<T> {
  trustLabel: "untrusted";
}

const untrusted = <T>(result: SourceResult<T>): CalendarToolResult<T> => ({
  ...result,
  trustLabel: "untrusted",
});

export function createCalendarEquipmentPlugin(
  options: CalendarEquipmentOptions = {},
): RussellPlugin {
  return {
    id: "equipment-google-calendar",
    name: "Google カレンダー",
    setup(ctx: AgentContext) {
      const clientId = options.clientId ?? process.env.GOOGLE_CLIENT_ID;
      const clientSecret = options.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
      const refreshToken = options.refreshToken ?? process.env.GOOGLE_REFRESH_TOKEN;
      if (!clientId || !clientSecret || !refreshToken) {
        console.warn(
          "[equipment-google-calendar] 認証情報が無いため、この装備は支給されません（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN）。",
        );
        return;
      }

      const client = new CalendarClient({
        auth: createGoogleAuth({
          clientId,
          clientSecret,
          refreshToken,
          fetchImpl: options.fetchImpl,
        }),
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });

      ctx.policy.declareEffect("calendar.upcoming", "read");

      const offEquipment = ctx.equipment.register({
        id: "google-calendar",
        mcpServer: { kind: "http", baseUrl: "https://www.googleapis.com/calendar/v3" },
        // スコープの実体は Google 側の共有設定。共有を外せば即座に読めなくなる（§9.3）
        scopes: ["calendar:read"],
        // 効果分類から導出（read → 0）。手で盛らない（guides/22）
        dangerLevel: 0,
        tools: () => [{ name: "calendar.upcoming", effect: "read" }],
      });

      const offUpcoming = ctx.tools.register("calendar.upcoming", {
        name: "calendar.upcoming",
        effect: "read",
        async run(input: { from?: string; days?: number; query?: string; limit?: number }): Promise<
          CalendarToolResult<CalendarEvent[]>
        > {
          return untrusted(await client.upcoming(input ?? {}));
        },
      });

      return () => {
        offUpcoming();
        offEquipment();
      };
    },
  };
}
