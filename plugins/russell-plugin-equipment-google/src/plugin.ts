/**
 * 装備（§9）: Google Drive / ドキュメントを**読む**。
 *
 * 会議の文字起こしはここに出る（Meet が Google ドキュメントとして保存する）。
 * Meet の API を使わずに済むのが利点で、**共有されたかどうか**だけが境界になる。
 *
 * **読み取りしか持たない。** 書き込みは `external_write` になり、承認の設計が要る
 * （Notion で通した道筋と同じで、まず読める装備を支給する, §9.3）。
 *
 * 認証が無いときは**何も register しない**。「未支給の装備はツール定義自体を
 * コンテキストに載せない」（§9.2）——個体は持っていない能力の存在すら知らない。
 */

import type { AgentContext, RussellPlugin, SourceResult } from "@edv4h/russell-shared";
import { type FetchLike, createGoogleAuth } from "./auth.js";
import { type DriveDocument, type DriveFile, GoogleClient, fileIdFrom } from "./client.js";

export interface GoogleEquipmentOptions {
  clientId?: string;
  clientSecret?: string;
  /** **個体ごと**の鍵。これが「誰として読むか」を決める。 */
  refreshToken?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  defaultLimit?: number;
}

/** ツールの戻り値。**中身は必ず untrusted**（他者が書いた文書, §12-3）。 */
export interface GoogleToolResult<T> extends SourceResult<T> {
  trustLabel: "untrusted";
}

const untrusted = <T>(result: SourceResult<T>): GoogleToolResult<T> => ({
  ...result,
  trustLabel: "untrusted",
});

export function createGoogleEquipmentPlugin(options: GoogleEquipmentOptions = {}): RussellPlugin {
  return {
    id: "equipment-google",
    name: "Google Drive",
    setup(ctx: AgentContext) {
      const clientId = options.clientId ?? process.env.GOOGLE_CLIENT_ID;
      const clientSecret = options.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
      const refreshToken = options.refreshToken ?? process.env.GOOGLE_REFRESH_TOKEN;
      if (!clientId || !clientSecret || !refreshToken) {
        console.warn(
          "[equipment-google] 認証情報が無いため、この装備は支給されません（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN）。",
        );
        return;
      }

      const client = new GoogleClient({
        auth: createGoogleAuth({
          clientId,
          clientSecret,
          refreshToken,
          fetchImpl: options.fetchImpl,
        }),
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      const defaultLimit = options.defaultLimit ?? 5;

      ctx.policy.declareEffect("drive.search", "read");
      ctx.policy.declareEffect("drive.read", "read");

      const offEquipment = ctx.equipment.register({
        id: "google-drive",
        mcpServer: { kind: "http", baseUrl: "https://www.googleapis.com/drive/v3" },
        // **スコープの実体は Google 側の共有設定**。ここに書くのはその宣言で、
        // 共有を外せば即座に読めなくなる（回収と同じ効果, §9.3）
        scopes: ["drive:read", "documents:read"],
        // 効果分類から導出（read → 0）。手で盛らない（guides/22）
        dangerLevel: 0,
        tools: () => [
          { name: "drive.search", effect: "read" },
          { name: "drive.read", effect: "read" },
        ],
      });

      const offSearch = ctx.tools.register("drive.search", {
        name: "drive.search",
        effect: "read",
        async run(input: { query: string; limit?: number }): Promise<
          GoogleToolResult<DriveFile[]>
        > {
          const query = (input?.query ?? "").trim();
          if (query === "") {
            return untrusted({ status: "complete", data: [], freshness: new Date().toISOString() });
          }
          return untrusted(await client.search(query, input?.limit ?? defaultLimit));
        },
      });

      const offRead = ctx.tools.register("drive.read", {
        name: "drive.read",
        effect: "read",
        async run(input: { fileId: string }): Promise<GoogleToolResult<DriveDocument>> {
          // URL でも ID でも受ける（人は URL を貼る）
          const fileId = fileIdFrom(input?.fileId ?? "");
          if (fileId === "") {
            return untrusted({ status: "failed", freshness: new Date().toISOString() });
          }
          return untrusted(await client.read(fileId));
        },
      });

      return () => {
        offRead();
        offSearch();
        offEquipment();
      };
    },
  };
}
