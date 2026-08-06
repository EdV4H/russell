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
