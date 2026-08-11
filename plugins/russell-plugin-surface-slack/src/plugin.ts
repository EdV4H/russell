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
  ConversationCapability,
  DeliveryResult,
  InboundMessage,
  KillSwitchCapability,
  OutboundMessage,
  ReactionRequest,
  RussellPlugin,
} from "@edv4h/russell-shared";
import { CONVERSATION_SERVICE, KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";
import bolt from "@slack/bolt";
import { pendingReply, withinWindow } from "./catchup.js";
import { type SlackHistoryMessage, hasOwnMessage, toTurns } from "./conversation.js";
import {
  allowedChannelsFromEnv,
  excludedChannelsFromEnv,
  fromAppMention,
  fromDirectMessage,
  inspectChannelMessage,
  parseContextId,
} from "./inbound.js";
import { operatorCheckFromEnv, runRussellCommand } from "./killswitch-command.js";

/** リアクションの意味 → Slack の絵文字名。何で表すかは通信面の裁量（§10.1）。 */
/** DM など、スレッドではない文脈で遡る件数。 */
const MAX_HISTORY = 20;

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
  /**
   * 追従から除外するチャンネル（既定 env `RUSSELL_SLACK_EXCLUDE_CHANNELS`）。
   * 招待されていても入っていかない。
   */
  excludedChannels?: ReadonlySet<string>;
  /**
   * 厳格モード（既定 env `RUSSELL_SLACK_CHANNELS`）。指定するとこのチャンネルだけに絞る。
   * **未指定が既定** ＝ 招待されたチャンネルすべて（opt-in の実体は Slack の招待）。
   */
  allowedChannels?: ReadonlySet<string>;
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
      const allowedChannels = options.allowedChannels ?? allowedChannelsFromEnv();
      const excludedChannels = options.excludedChannels ?? excludedChannelsFromEnv();
      /** `RUSSELL_SLACK_DEBUG=1` で受信の採用/破棄を1行ずつ出す。既定は無効。 */
      const debug = process.env.RUSSELL_SLACK_DEBUG === "1";
      /**
       * Bob が発言したスレッド。ここに載っているスレッドの続きだけを拾う（inbound.ts）。
       *
       * プロセス内にしか持たないので**再起動すると忘れる**（そのスレッドで一度 mention
       * すれば戻る）。DB に置けば残せるが、テーブルが1つ増える。P0 の範囲ではこれで足りる。
       */
      const activeThreads = new Set<string>();
      /** listener の context からしか取れないので、最初に見たものを控えて capability から使う。 */
      const botUserIdRef: { value?: string } = {};

      /** 参加していないと分かったスレッド。毎回 API を叩かないための否定キャッシュ。 */
      const notMine = new Set<string>();

      /** そのスレッド/DM の発言列を取る。取れなければ空。 */
      async function fetchMessages(contextId: string): Promise<SlackHistoryMessage[]> {
        const { channel, thread } = parseContextId(contextId);
        if (!channel) return [];
        const res = thread
          ? await app.client.conversations.replies({ channel, ts: thread, limit: 200 })
          : await app.client.conversations.history({ channel, limit: MAX_HISTORY });
        const messages = (res.messages ?? []) as SlackHistoryMessage[];
        // conversations.history は新しい順に返す。会話としては古い順に並べる。
        return thread ? messages : [...messages].reverse();
      }

      /**
       * 起動前からあるスレッドでも会話に戻れるようにする（ADR 0001）。
       * **自分が発言しているスレッドだけ**参加とみなす——呼ばれてもいない会話には入らない。
       */
      async function recoverThread(contextId: string, botUserId?: string): Promise<boolean> {
        if (activeThreads.has(contextId)) return true;
        if (notMine.has(contextId)) return false;
        try {
          const messages = await fetchMessages(contextId);
          if (!hasOwnMessage(messages, botUserId)) {
            notMine.add(contextId);
            return false;
          }
          activeThreads.add(contextId);
          return true;
        } catch {
          return false;
        }
      }

      // コアが「手元に会話が無い」ときに呼ぶ（再起動後など）。
      ctx.services.provide<ConversationCapability>(CONVERSATION_SERVICE, {
        async history(contextId: string) {
          try {
            return toTurns(await fetchMessages(contextId), botUserIdRef.value);
          } catch {
            return [];
          }
        },
      });

      const unregister = ctx.surfaces.register({
        id: "slack",
        async start(sink) {
          // @mention
          app.event("app_mention", async ({ event, context }) => {
            botUserIdRef.value ??= context.botUserId;
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
          // DM (message.im) と、参加しているスレッドの続き（message.channels / message.groups）。
          // bot 自身の発言をここで弾かないと、自分の返信に返事を続ける。
          app.message(async ({ message, context }) => {
            // biome-ignore lint/suspicious/noExplicitAny: Bolt の message union は広い。解釈は inbound.ts に集約。
            const m = message as any;
            const dm = fromDirectMessage(m);
            if (dm) {
              if (debug) console.log(`[slack] 採用 dm ${dm.contextId}`);
              sink(dm);
              return;
            }
            botUserIdRef.value ??= context.botUserId;
            const follow = {
              allowedChannels,
              excludedChannels,
              activeThreads,
              botUserId: context.botUserId,
            };
            let seen = inspectChannelMessage(m, follow);
            // 知らないスレッドなら Slack に聞く。自分が発言していれば会話に戻る（ADR 0001）。
            if (seen.dropped === "thread_not_joined" && m?.channel && m?.thread_ts) {
              const contextId = `${m.channel}:${m.thread_ts}`;
              if (await recoverThread(contextId, context.botUserId)) {
                seen = inspectChannelMessage(m, follow);
                if (debug) console.log(`[slack] 復元 ${contextId}`);
              }
            }
            // **届いたのに捨てた**ことを見えるようにする。反応しないときに
            // 「Slack が配っていない」のか「こちらが捨てた」のかを切り分けられないと詰む。
            if (debug) {
              console.log(
                seen.accepted
                  ? `[slack] 採用 thread ${seen.accepted.contextId}`
                  : `[slack] 破棄 ${seen.dropped} ch=${m?.channel} thread=${m?.thread_ts ?? "-"}`,
              );
            }
            if (seen.accepted) sink(seen.accepted);
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
            // 発言したスレッドを覚えておく。以降このスレッドの続きは mention 無しで拾う。
            if (thread) activeThreads.add(out.contextId);
            return { status: "succeeded" };
          } catch {
            // タイムアウト等は unknown（blind retry しない, §9.2）
            return { status: "unknown" };
          }
        },
        /**
         * 返信し忘れているやりとりを探す（積み残しの確認）。
         *
         * 探し方: 参加しているチャンネル/DM の直近の発言を見て、**やりとりの単位**
         * （スレッド or DM）を候補に挙げ、それぞれの最後の発言が自分でなければ返信が要る。
         *
         * ここで API を叩く回数は「チャンネル数 + 候補スレッド数」に比例するので、
         * 窓と件数の両方で必ず頭を打つようにしてある。**取りこぼしより叩きすぎの方が事故になる。**
         */
        async pendingMessages({ since, limit }): Promise<InboundMessage[]> {
          const found: InboundMessage[] = [];
          try {
            const convos = await app.client.users.conversations({
              types: "public_channel,private_channel,im",
              exclude_archived: true,
              limit: 200,
            });
            const oldest = String(Math.floor(since.getTime() / 1000));

            for (const c of convos.channels ?? []) {
              if (found.length >= limit) break;
              const channel = c.id;
              if (!channel) continue;
              const isDm = c.is_im === true;
              if (!isDm && excludedChannels?.has(channel)) continue;
              if (!isDm && allowedChannels && !allowedChannels.has(channel)) continue;

              const history = await app.client.conversations.history({
                channel,
                oldest,
                limit: MAX_HISTORY,
              });
              const messages = (history.messages ?? []) as SlackHistoryMessage[];

              // 候補のやりとり。DM はチャンネル直下、チャンネルはスレッド単位（ADR 0002）。
              const contexts = isDm
                ? [`${channel}:`]
                : [
                    ...new Set(
                      messages
                        // biome-ignore lint/suspicious/noExplicitAny: history の生要素。thread_ts は型に無い
                        .map((m) => (m as any).thread_ts as string | undefined)
                        .filter((t): t is string => Boolean(t)),
                    ),
                  ].map((t) => `${channel}:${t}`);

              for (const contextId of contexts) {
                if (found.length >= limit) break;
                const thread = await fetchMessages(contextId);
                const pending = pendingReply(thread, botUserIdRef.value);
                // 古すぎるものは拾わない。3日前の話に今さら返すのは回復ではなく事故に見える
                if (!pending || !withinWindow(pending.messageId, since)) continue;
                found.push({
                  surfaceId: "slack",
                  contextId,
                  author: pending.author,
                  text: pending.text,
                  trustLabel: "untrusted",
                  isMention: true, // 呼ばれた扱い（自分が関与しているやりとりなので）
                  messageId: pending.messageId,
                });
                if (!isDm) activeThreads.add(contextId);
              }
            }
          } catch (err) {
            // 拾い直しに失敗しても通常の受信は動く。黙らないようにログだけ残す
            console.warn(
              `[slack] 積み残しの確認に失敗: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (debug) console.log(`[slack] 積み残し ${found.length}件`);
          return found;
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
