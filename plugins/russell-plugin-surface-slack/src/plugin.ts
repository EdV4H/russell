/**
 * 通信面プラグイン: Slack（Bolt for JavaScript / Socket Mode）。
 * 設計書 §10 / plugin-first の surface-slack。個体ごとに別 Slack アプリ（B-2 決定）。
 *
 * ※ SLACK_BOT_TOKEN / SLACK_APP_TOKEN が要る（実地検証はトークン準備後）。型は @slack/bolt に対して
 *   コンパイル確認済み。Bolt のイベント payload は union が広いので、必要箇所は緩めに受けている
 *   （実結線時に厳密化する）。
 *
 * 責務:
 * - 受信: app_mention と DM(im) を InboundMessage(untrusted) に正規化して sink へ（§6.1/§12-3）。
 *   解釈は `inbound.ts`（Slack 接続なしにテストできる純関数）に置く
 * - 送信: contextId = "channel:thread" をパースして返す（thread が空なら DM 直下）
 * - リアクション: メモを取ったことを 📝 で可視化する（§10.1）
 * - キルスイッチ: スラッシュコマンド `/russell`（§12-4。docs/reference/35-killswitch.md）
 * - スコープは最小（app_mentions:read / channels:history / im:history / chat:write / reactions:write /
 *   commands, §10）
 */

import type {
  AgentContext,
  DeliveryResult,
  KillSwitchCapability,
  OutboundMessage,
  ReactionRequest,
  RussellPlugin,
} from "@edv4h/russell-shared";
import { KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";
import bolt from "@slack/bolt";
import { fromAppMention, fromDirectMessage, parseContextId } from "./inbound.js";
import { operatorCheckFromEnv, runRussellCommand } from "./killswitch-command.js";

/** リアクションの意味 → Slack の絵文字名。何で表すかは通信面の裁量（§10.1）。 */
const REACTION_EMOJI: Record<ReactionRequest["kind"], string> = {
  noted: "memo", // 📝「メモしました」
};

export interface SlackSurfaceOptions {
  botToken?: string;
  appToken?: string;
  /**
   * 発動記録を流す管理チャンネル（既定 env `RUSSELL_ADMIN_CHANNEL`）。
   * 未設定なら流さない（kill-switch.md の「#russell-管理 に自動で記録」に対応）。
   */
  adminChannel?: string;
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

      const unregister = ctx.surfaces.register({
        id: "slack",
        async start(sink) {
          // @mention
          app.event("app_mention", async ({ event }) => {
            // biome-ignore lint/suspicious/noExplicitAny: Bolt の event union は広い。解釈は inbound.ts に集約。
            sink(fromAppMention(event as any));
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
          // DM (message.im)。bot 自身の発言をここで弾かないと、自分の返信に返事を続ける。
          app.message(async ({ message }) => {
            // biome-ignore lint/suspicious/noExplicitAny: Bolt の message union は広い。解釈は inbound.ts に集約。
            const msg = fromDirectMessage(message as any);
            if (msg) sink(msg);
          });
          await app.start();
        },
        async send(out: OutboundMessage): Promise<DeliveryResult> {
          const { channel, thread } = parseContextId(out.contextId);
          try {
            // thread が空なら DM 直下。空文字を thread_ts に渡すと Slack が弾く。
            await app.client.chat.postMessage({
              channel,
              thread_ts: thread || undefined,
              text: out.text,
            });
            return { status: "succeeded" };
          } catch {
            // タイムアウト等は unknown（blind retry しない, §9.2）
            return { status: "unknown" };
          }
        },
        async react(req: ReactionRequest): Promise<DeliveryResult> {
          const { channel } = parseContextId(req.contextId);
          try {
            await app.client.reactions.add({
              channel,
              timestamp: req.messageId,
              name: REACTION_EMOJI[req.kind],
            });
            return { status: "succeeded" };
          } catch (err) {
            // 既に付いている（already_reacted）は成功と同じ。それ以外は結果を返して監査に残す。
            const detail = err instanceof Error ? err.message : String(err);
            if (detail.includes("already_reacted")) return { status: "succeeded" };
            return { status: "unknown", detail };
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
