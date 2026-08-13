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
  AlertSink,
  ConversationCapability,
  DeliveryResult,
  InboundMessage,
  KillSwitchCapability,
  OutboundMessage,
  ReactionRequest,
  RussellPlugin,
  SettingsCapability,
} from "@edv4h/russell-shared";
import {
  ALERT_SERVICE,
  CONVERSATION_SERVICE,
  KILL_SWITCH_SERVICE,
  SETTINGS_SERVICE,
} from "@edv4h/russell-shared";
import bolt from "@slack/bolt";
import { findPendingMessages, pendingReply, withinWindow } from "./catchup.js";
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
import { toSlackMrkdwn } from "./mrkdwn.js";
import { createNameResolver, mentionedIds } from "./names.js";
import { createTextMemo, defaultReactionEmoji, pickReactionEmoji } from "./reactions.js";

/** リアクションの意味 → Slack の絵文字名。何で表すかは通信面の裁量（§10.1）。 */
/** DM など、スレッドではない文脈で遡る件数。 */
const MAX_HISTORY = 20;

export interface SlackSurfaceOptions {
  botToken?: string;
  appToken?: string;
  /**
   * 発動記録を流す管理チャンネル（既定 env `RUSSELL_ADMIN_CHANNEL`）。
   * 未設定なら流さない（kill-switch.md の「#russell-管理 に自動で記録」に対応）。
   */
  adminChannel?: string;
  /**
   * 安全側に倒れたことを流す先（既定 env `RUSSELL_ALERT_CHANNEL`）。
   *
   * **管理チャンネルとは別**。発動記録は「人がやった1回」だが、通知は壊れている間ずっと出る。
   * 未設定なら Slack へは流さない（プロセスログには出る, #25）。
   */
  alertChannel?: string;
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

/**
 * 積み残しの確認に追加で要るスコープ。
 *
 * 「どのチャンネルに入っているか」を数えるための権限で、**通常の受信・返信には要らない**。
 * 足さなくても Bob は普通に働く（拾い直しだけが動かない）。
 */
export const CATCHUP_SCOPES = ["channels:read", "groups:read", "im:read"] as const;

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
      /**
       * 受け取った発言の本文の控え。**絵文字を選ぶためだけに使う**（`reactions.ts`）。
       * `react()` には id しか渡ってこないので、ここで覚えておかないと文面が分からない。
       */
      const textMemo = createTextMemo();
      /** listener の context からしか取れないので、最初に見たものを控えて capability から使う。 */
      const botUserIdRef: { value?: string } = {};

      /** 参加していないと分かったスレッド。毎回 API を叩かないための否定キャッシュ。 */
      const notMine = new Set<string>();

      /**
       * その発言に出てくる人の名前を引く（発言者 + mention されている人）。
       *
       * **人が見ているのと同じものを見せる**ため。id のままだと、個体は相手が誰か
       * 分からないまま会話し、実際に存在しない名前を作った。
       */
      const nameResolver = createNameResolver(app.client);
      async function namesFor(text?: string, author?: string): Promise<Map<string, string>> {
        const ids = [...mentionedIds(text ?? ""), ...(author ? [author] : [])];
        if (ids.length === 0) return new Map();
        return await nameResolver.resolve(ids);
      }

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

      // 運用への通知先（#25）。**既定は投稿しない。**
      //
      // 管理チャンネルに相乗りさせない理由は、性質が違うから——キルスイッチの発動記録は
      // 「人がやった1回」だが、通知は**壊れている間ずっと出る**。同じ場所へ流すかどうかは
      // 運用が決めることなので、専用の設定にして**明示的に有効化されたときだけ**流す。
      // 設定が無ければプラグイン側がログに出す（黙りはしない）。
      const alertChannel = options.alertChannel ?? process.env.RUSSELL_ALERT_CHANNEL;
      if (alertChannel) {
        ctx.services.provide<AlertSink>(ALERT_SERVICE, {
          async send(text: string) {
            // 監査もモードも通さない。**壊れているときに使う経路**なので、
            // 途中に関門を置くと、いちばん要るときに届かない（#25）。
            // 宛先は管理チャンネル固定・本文は定型なので、会話が漏れることはない。
            await app.client.chat.postMessage({ channel: alertChannel, text });
          },
        });
      }

      // コアが「手元に会話が無い」ときに呼ぶ（再起動後など）。
      ctx.services.provide<ConversationCapability>(CONVERSATION_SERVICE, {
        async history(contextId: string) {
          try {
            const messages = await fetchMessages(contextId);
            // **発言者の名前を引いてから渡す。**
            // id のまま渡すと、いま届いた発言（表示名）と履歴（id）で**同じ人が2人に見え**、
            // 「相手が1人かどうか」の判断が狂う。実際、1対1のスレッドが3人扱いになって
            // 判定モデルへ回り、直接聞かれた質問に黙った。
            // モデルにとっても、履歴の発言者が id のままなのは見え方が悪い（存在しない名前を作る）。
            const names = await nameResolver.resolve(
              messages.map((m) => m.user).filter((u): u is string => Boolean(u)),
            );
            return toTurns(messages, botUserIdRef.value, names);
          } catch {
            return [];
          }
        },
      });

      const unregister = ctx.surfaces.register({
        id: "slack",
        async start(rawSink) {
          // 流す前に本文を控える。**リアクションの絵文字を選ぶためだけ**の控えなので、
          // 記憶でも監査でもない（プロセス内・上限つき・再起動で消える）。
          const sink = (m: InboundMessage) => {
            textMemo.remember(m.messageId, m.text);
            rawSink(m);
          };
          // @mention
          app.event("app_mention", async ({ event, context }) => {
            botUserIdRef.value ??= context.botUserId;
            // biome-ignore lint/suspicious/noExplicitAny: Bolt の event union は広い。解釈は inbound.ts に集約。
            const e = event as any;
            sink(fromAppMention(e, await namesFor(e.text, e.user)));
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
                settings: ctx.services.get<SettingsCapability>(SETTINGS_SERVICE),
                channelId: command.channel_id,
              });
              await respond({ response_type: "ephemeral", text: result.reply });
              // **宣言はチャンネル全員に見える形で出す**（ephemeral では意味がない）。
              // 日報の出し先が静かに移らないための仕掛け。
              if (result.declare && command.channel_id) {
                await app.client.chat.postMessage({
                  channel: command.channel_id,
                  text: result.declare,
                });
              }
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
            const names = await namesFor(m?.text, m?.user);
            const dm = fromDirectMessage(m, names);
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
              names,
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
              // **Slack の書式へ直してから送る。** コアは Markdown を書くので、
              // そのままだと `**強調**` が記号のまま出る（見え方は面の都合, §10.1）
              text: toSlackMrkdwn(out.text),
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
          // 探し方は catchup.ts（テストできる形に切ってある）。ここは実クライアントを渡すだけ。
          const { found, skipped, reasons } = await findPendingMessages({
            since,
            limit,
            botUserId: botUserIdRef.value,
            allowedChannels,
            excludedChannels,
            names: (text, author) => namesFor(text, author),
            listConversations: async () => {
              const res = await app.client.users.conversations({
                types: "public_channel,private_channel,im",
                exclude_archived: true,
                limit: 200,
              });
              return (res.channels ?? []).map((c) => ({ id: c.id, isDm: c.is_im === true }));
            },
            history: async (channel, oldest) => {
              const res = await app.client.conversations.history({
                channel,
                oldest,
                limit: MAX_HISTORY,
              });
              return (res.messages ?? []) as SlackHistoryMessage[];
            },
            messages: (contextId) => fetchMessages(contextId),
            onJoined: (contextId) => activeThreads.add(contextId),
          });
          // **読めなかったことを黙らない。** 0件が「無い」なのか「見られなかった」なのかは別物
          if (skipped > 0) {
            // **理由まで出す。** 「毎回1件読めない」が権限不足なのか消えたチャンネルなのかで、
            // 直せるものかどうかが変わる（数だけだと見なかったことにするしかない）
            console.log(
              `[slack] 積み残しの確認: ${skipped}件の会話は読めませんでした（${reasons.join(", ")}／続行）`,
            );
          }
          if (debug) console.log(`[slack] 積み残し ${found.length}件`);
          for (const m of found) textMemo.remember(m.messageId, m.text);
          return found;
        },
        async react(req: ReactionRequest): Promise<DeliveryResult> {
          const { channel } = parseContextId(req.contextId);
          const add = async (name: string) => {
            await app.client.reactions.add({ channel, timestamp: req.messageId, name });
          };
          const chosen = pickReactionEmoji(req.kind, textMemo.get(req.messageId));
          try {
            await add(chosen);
            return { status: "succeeded" };
          } catch (err) {
            // 既に付いている（already_reacted）は成功と同じ。それ以外は結果を返して監査に残す。
            const detail = err instanceof Error ? err.message : String(err);
            if (detail.includes("already_reacted")) return { status: "succeeded" };
            // **選んだ名前が無いだけなら、既定へ落として付け直す。**
            // 絵文字を選り好みした結果、何も付かなくなるのは本末転倒
            const fallback = defaultReactionEmoji(req.kind);
            if (detail.includes("invalid_name") && chosen !== fallback) {
              try {
                await add(fallback);
                return { status: "succeeded" };
              } catch (err2) {
                const d2 = err2 instanceof Error ? err2.message : String(err2);
                if (d2.includes("already_reacted")) return { status: "succeeded" };
                return { status: "unknown", detail: d2 };
              }
            }
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
