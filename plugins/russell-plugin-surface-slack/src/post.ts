/**
 * 装備としての Slack：**いま話している場所以外へ投稿する**（`slack.post`）。
 *
 * 面としての Slack は「返事をする」しかできない。会議の要点を #チーム へ流す、といった
 * 「**別の場所へ持っていく**」ができないので、読んだものが本人の中で止まっていた。
 *
 * > [!IMPORTANT]
 * > **これは返信ではなく送信である。** 効果分類は `external_send`——投稿すればその
 * > チャンネルの全員に届く。だから実行の前に人の承認が入り、`dryrun` では止まる
 * > （Policy Gate が効果分類で判断する）。
 * >
 * > **承認画面には、どこへ・何を、の両方を出す。** 押す人が投稿先を確かめられないと、
 * > 「たぶん合っている」で押すことになる。投稿先を絞る設定は置いていない——
 * > 絞ると「なぜ投げられないのか」が分からない詰まり方をするうえ、承認で毎回止まる。
 */

import type { AgentContext, SourceResult } from "@edv4h/russell-shared";
import type { WebClient } from "@slack/web-api";
import { toSlackMrkdwn } from "./mrkdwn.js";

export interface SlackPostDeps {
  client: Pick<WebClient, "chat" | "conversations">;
}

/** Slack のチャンネル id の形（C=公開/非公開, G=旧private, D=DM）。 */
const LOOKS_LIKE_ID = /^[CGD][A-Z0-9]{6,}$/;

/**
 * 承認画面に出す「どこへ」。**引けなければ渡された文字列をそのまま見せる**（当てない）。
 *
 * id のまま見せると、押す人には投稿先が分からない。かといって推測で名前を作ると、
 * **間違った安心**を与える——引けなかったことは、引けなかったまま見せる。
 */
export async function channelLabel(
  client: Pick<WebClient, "conversations">,
  channel: string,
): Promise<string> {
  const raw = channel.trim();
  if (!LOOKS_LIKE_ID.test(raw)) return raw; // 「#チーム」等はそのまま読める
  try {
    const info = await client.conversations.info({ channel: raw });
    const name = info.channel?.name;
    return name ? `#${name}` : raw;
  } catch {
    return raw;
  }
}

export function registerSlackPost(ctx: AgentContext, deps: SlackPostDeps): () => void {
  ctx.policy.declareEffect("slack.post", "external_send");

  const offEquipment = ctx.equipment.register({
    id: "slack",
    mcpServer: { kind: "http", baseUrl: "https://slack.com/api" },
    scopes: ["chat:write"],
    // 効果分類から導出（external_send → 1）。手で盛らない・手で下げない（guides/22）
    dangerLevel: 1,
    tools: () => [{ name: "slack.post", effect: "external_send" as const }],
  });

  const offPost = ctx.tools.register("slack.post", {
    name: "slack.post",
    effect: "external_send",
    async describe(input: { channel?: string; text?: string }) {
      const channel = (input?.channel ?? "").trim();
      const where = channel ? await channelLabel(deps.client, channel) : "（宛先の指定なし）";
      return {
        summary: `Slack の ${where} へ投稿します`,
        // **本文をそのまま見せる。** 何が流れるか分からないまま押させない
        preview: input?.text ?? "",
      };
    },
    async run(input: { channel: string; text: string }): Promise<SourceResult<{ ts: string }>> {
      const channel = (input?.channel ?? "").trim();
      const text = (input?.text ?? "").trim();
      const now = new Date().toISOString();
      // **空の投稿をしない。** 承認を通ったからといって、中身の無いものを流しに行かない
      if (channel === "" || text === "") {
        return { status: "failed", freshness: now, detail: "宛先か本文がありません" };
      }
      try {
        const res = await deps.client.chat.postMessage({
          channel,
          text: toSlackMrkdwn(text),
        });
        return { status: "complete", freshness: now, data: { ts: String(res.ts ?? "") } };
      } catch (err) {
        // **届いたかどうか分からない**ときに投げ直さない（§9.2）。二重投稿の方が害が大きい。
        // 理由の手がかりは残す——`channel_not_found` と権限不足は、人がやることが違う
        const detail = err instanceof Error ? err.message : String(err);
        return { status: "failed", freshness: now, detail };
      }
    },
  });

  return () => {
    offPost();
    offEquipment();
  };
}
