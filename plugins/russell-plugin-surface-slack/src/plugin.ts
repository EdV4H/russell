/**
 * 通信面プラグイン: Slack（Bolt for JavaScript / Socket Mode）。
 * 設計書 §10 / plugin-first の surface-slack。個体ごとに別 Slack アプリ（B-2 決定）。
 *
 * ※ SLACK_BOT_TOKEN / SLACK_APP_TOKEN が要る（実地検証はトークン準備後）。型は @slack/bolt に対して
 *   コンパイル確認済み。Bolt のイベント payload は union が広いので、必要箇所は緩めに受けている
 *   （実結線時に厳密化する）。
 *
 * 責務:
 * - 受信: app_mention と DM(im) を InboundMessage(untrusted) に正規化して sink へ（§6.1/§12-3）
 * - 送信: contextId = "channel:thread_ts" をパースしてスレッドへ postMessage
 * - スコープは最小（app_mentions:read / channels:history / im:history / chat:write / reactions:write, §10）
 */

import type {
  AgentContext,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  RussellPlugin,
} from "@edv4h/russell-shared";
import bolt from "@slack/bolt";

export interface SlackSurfaceOptions {
  botToken?: string;
  appToken?: string;
}

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>\s*/g, "").trim();
}

export function createSlackSurfacePlugin(options: SlackSurfaceOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-surface-slack",
    name: "Slack Surface",
    setup(ctx: AgentContext) {
      const app = new bolt.App({
        token: options.botToken ?? process.env.SLACK_BOT_TOKEN,
        appToken: options.appToken ?? process.env.SLACK_APP_TOKEN,
        socketMode: true,
      });

      const emit = (
        sink: (m: InboundMessage) => void,
        channel: string,
        thread: string,
        author: string,
        text: string,
      ) =>
        sink({
          surfaceId: "slack",
          contextId: `${channel}:${thread}`,
          author,
          text,
          trustLabel: "untrusted", // 他者の Slack 発言は untrusted（§12-3）
          isMention: true,
        });

      const unregister = ctx.surfaces.register({
        id: "slack",
        async start(sink) {
          // @mention
          app.event("app_mention", async ({ event }) => {
            const e = event as {
              channel: string;
              ts: string;
              thread_ts?: string;
              user?: string;
              text?: string;
            };
            emit(
              sink,
              e.channel,
              e.thread_ts ?? e.ts,
              e.user ?? "unknown",
              stripMention(e.text ?? ""),
            );
          });
          // DM (message.im)
          app.message(async ({ message }) => {
            // biome-ignore lint/suspicious/noExplicitAny: Bolt の message union を実結線時に厳密化する。
            const m = message as any;
            if (m.channel_type === "im" && typeof m.text === "string") {
              emit(sink, m.channel, m.ts, m.user ?? "unknown", m.text);
            }
          });
          await app.start();
        },
        async send(out: OutboundMessage): Promise<DeliveryResult> {
          const sep = out.contextId.indexOf(":");
          const channel = sep >= 0 ? out.contextId.slice(0, sep) : out.contextId;
          const thread = sep >= 0 ? out.contextId.slice(sep + 1) : undefined;
          try {
            await app.client.chat.postMessage({ channel, thread_ts: thread, text: out.text });
            return { status: "succeeded" };
          } catch {
            // タイムアウト等は unknown（blind retry しない, §9.2）
            return { status: "unknown" };
          }
        },
      });

      return async () => {
        unregister();
        await app.stop();
      };
    },
  };
}
