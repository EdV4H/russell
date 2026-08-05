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
 * - キルスイッチ: スラッシュコマンド `/russell`（§12-4。docs/reference/35-killswitch.md）
 * - スコープは最小（app_mentions:read / channels:history / im:history / chat:write / reactions:write /
 *   commands, §10）
 */

import type {
  AgentContext,
  DeliveryResult,
  InboundMessage,
  KillSwitchCapability,
  OutboundMessage,
  RussellPlugin,
} from "@edv4h/russell-shared";
import { KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";
import bolt from "@slack/bolt";
import { operatorCheckFromEnv, runRussellCommand } from "./killswitch-command.js";

export interface SlackSurfaceOptions {
  botToken?: string;
  appToken?: string;
  /**
   * 発動記録を流す管理チャンネル（既定 env `RUSSELL_ADMIN_CHANNEL`）。
   * 未設定なら流さない（kill-switch.md の「#russell-管理 に自動で記録」に対応）。
   */
  adminChannel?: string;
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

      const adminChannel = options.adminChannel ?? process.env.RUSSELL_ADMIN_CHANNEL;
      const isOperator = operatorCheckFromEnv();

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
          // キルスイッチ（§12-4 レベル1/2）。認知ループを通さず、ここで直接処理する——
          // 「止めろ」がモデル呼び出しや Policy Gate に依存していては、暴走時に効かない。
          app.command("/russell", async ({ command, ack, respond }) => {
            await ack(); // Slack の3秒制約。処理は ack の後で
            try {
              const result = await runRussellCommand(command.text ?? "", command.user_id, {
                capability: ctx.services.get<KillSwitchCapability>(KILL_SWITCH_SERVICE),
                selfAgentId: ctx.runtime.agentId,
                isOperator,
              });
              await respond({ response_type: "ephemeral", text: result.reply });
              if (result.announce && adminChannel) {
                await app.client.chat.postMessage({ channel: adminChannel, text: result.announce });
              }
            } catch (err) {
              // 失敗を黙って飲まない。発動したつもりで止まっていない状態が一番危ない。
              await respond({
                response_type: "ephemeral",
                text: `失敗しました: ${err instanceof Error ? err.message : String(err)}\n別経路（env \`RUSSELL_KILL=1\` で再起動）で止めてください。`,
              });
            }
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
