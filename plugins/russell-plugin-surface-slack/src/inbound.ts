/**
 * Slack のイベントを `InboundMessage` に正規化する（§10 / §12-3）。
 *
 * **Slack 接続を持たない純関数**にしてある。ここが surface-slack で唯一「解釈」をする場所で、
 * 間違えると記憶の紐づけや無限ループになる——トークンが無いと試せない、では困る。
 *
 * contextId は `"channel:thread"`。thread が空文字ならスレッドを作らずチャンネル（DM）直下を指す。
 */

import type { InboundMessage } from "@edv4h/russell-shared";

export interface SlackTarget {
  channel: string;
  /** 空文字ならスレッドではなくチャンネル直下。 */
  thread: string;
}

export function toContextId(channel: string, thread?: string): string {
  return `${channel}:${thread ?? ""}`;
}

export function parseContextId(contextId: string): SlackTarget {
  const sep = contextId.indexOf(":");
  if (sep < 0) return { channel: contextId, thread: "" };
  return { channel: contextId.slice(0, sep), thread: contextId.slice(sep + 1) };
}

export function stripMention(text: string): string {
  return text.replace(/<@[^>]+>\s*/g, "").trim();
}

export interface SlackMentionEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
}

/**
 * `app_mention`。**mention には必ずスレッドで返す**ので、スレッド外で呼ばれたら
 * その発言自身（ts）をスレッドの根にする。
 */
export function fromAppMention(e: SlackMentionEvent): InboundMessage {
  return {
    surfaceId: "slack",
    contextId: toContextId(e.channel, e.thread_ts ?? e.ts),
    author: e.user ?? "unknown",
    text: stripMention(e.text ?? ""),
    trustLabel: "untrusted", // 他者の Slack 発言は untrusted（§12-3）
    isMention: true,
    messageId: e.ts,
  };
}

export interface SlackMessageEvent {
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * DM（`message.im`）。受け付けないものは undefined を返す。
 *
 * - **bot の発言は必ず捨てる。** 自分の返信も `message.im` で戻ってくるので、
 *   拾うと自分に返事をし続ける
 * - `subtype` 付き（編集・削除・参加通知など）も捨てる。本文が無い/意味が違う
 * - contextId は**スレッドが無ければチャンネル単位**。ここを ts にすると発言ごとに
 *   別文脈になり、DM ではメモが1件ずつ孤立して想起が効かなくなる
 */
export function fromDirectMessage(m: SlackMessageEvent): InboundMessage | undefined {
  if (m.channel_type !== "im") return undefined;
  if (m.bot_id || m.subtype) return undefined;
  if (typeof m.text !== "string" || m.text.trim() === "") return undefined;
  if (!m.channel || !m.ts) return undefined;
  return {
    surfaceId: "slack",
    contextId: toContextId(m.channel, m.thread_ts),
    author: m.user ?? "unknown",
    text: m.text,
    trustLabel: "untrusted",
    isMention: true, // DM は宛先が自分しかいない＝常に自分への発話
    messageId: m.ts,
  };
}

/**
 * チャンネルのスレッド追従に必要な文脈。
 *
 * Slack のイベント購読は**種類単位でしか絞れない**ので、`message.channels` を購読すると
 * 参加チャンネルの全発言が届く。届いたものをどこまで扱うかを決めるのがここ。
 */
export interface ChannelFollowContext {
  /**
   * 拾ってよいチャンネル（ID）。**空なら何も拾わない。**
   * privacy-and-memory-policy の「明示的に招待され、かつ台帳登録されたチャンネルのみ。
   * 勝手読みは既定禁止」を実装したもの。設定漏れが「全部読む」に倒れてはいけない。
   */
  allowedChannels: ReadonlySet<string>;
  /** Bob が既に発言したスレッド（contextId）。会話の続きだけを拾うための目印。 */
  activeThreads: ReadonlySet<string>;
  /** 自分の bot user id。mention は app_mention 側が拾うので、ここでは二重に処理しない。 */
  botUserId?: string;
}

/**
 * チャンネルの発言（`message.channels` / `message.groups`）。
 * **拾うのは「Bob が参加しているスレッドの続き」だけ**で、それ以外は捨てる。
 *
 * 捨てる理由が3種類あるので順に:
 * - allowlist に無いチャンネル … opt-in していない場所を読まない
 * - スレッド外の発言 … チャンネルの雑談を拾い始めると「全部読んでいる」になる
 * - Bob がまだ発言していないスレッド … 呼ばれてもいない会話に入っていかない
 *
 * mention を含む発言は `app_mention` でも届くので、ここでは捨てる（両方処理すると2回返信する）。
 */
export function fromChannelMessage(
  m: SlackMessageEvent,
  ctx: ChannelFollowContext,
): InboundMessage | undefined {
  if (m.channel_type !== "channel" && m.channel_type !== "group") return undefined;
  if (m.bot_id || m.subtype) return undefined;
  if (typeof m.text !== "string" || m.text.trim() === "") return undefined;
  if (!m.channel || !m.ts) return undefined;
  if (!ctx.allowedChannels.has(m.channel)) return undefined;
  if (!m.thread_ts) return undefined; // スレッド外は拾わない
  if (ctx.botUserId && m.text.includes(`<@${ctx.botUserId}>`)) return undefined; // app_mention が拾う

  const contextId = toContextId(m.channel, m.thread_ts);
  if (!ctx.activeThreads.has(contextId)) return undefined;

  return {
    surfaceId: "slack",
    contextId,
    author: m.user ?? "unknown",
    text: m.text,
    trustLabel: "untrusted",
    isMention: true, // 自分が参加しているスレッドの続き＝自分への発話として扱う
    messageId: m.ts,
  };
}

/** env の `RUSSELL_SLACK_CHANNELS`（カンマ区切り）から allowlist を作る。未設定なら空＝追従しない。 */
export function allowedChannelsFromEnv(raw = process.env.RUSSELL_SLACK_CHANNELS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
