/**
 * Slack から会話を取り直す（ADR 0001）。
 *
 * 短期記憶はプロセス内にしかないので再起動で消えるが、会話は Slack に残っている。
 * 保存する代わりに、必要になった時点で取り直す。
 *
 * Slack API を叩く部分と、**取れた発言列をどう解釈するか**を分けてある。後者が
 * 間違うと「自分の発言を相手の発言として読む」ことになり、会話が壊れる。
 */

import type { ModelTurn } from "@edv4h/russell-shared";
import { stripMention } from "./inbound.js";

/** `conversations.replies` / `conversations.history` の応答のうち、こちらが使う部分。 */
export interface SlackHistoryMessage {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  /** スレッドの根。**親自身にも入る**（親は `thread_ts === ts`）。 */
  thread_ts?: string;
  /** そのスレッドの最新の返信。**親が古くても、ここが新しければ会話は生きている**。 */
  latest_reply?: string;
}

/** 何発言まで文脈として使うか。コアの短期記憶と同じ長さに揃える。 */
export const MAX_RECOVERED_TURNS = 20;

/**
 * Slack の発言列を会話履歴にする。
 *
 * - 自分の発言は `assistant`、それ以外は `user`
 * - `subtype` 付き（参加通知・編集など）と空文字は落とす
 * - mention 記法は落とす（`app_mention` の扱いと揃える）
 * - 直近 `MAX_RECOVERED_TURNS` 件だけ使う
 */
export function toTurns(
  messages: SlackHistoryMessage[],
  botUserId?: string,
  names?: ReadonlyMap<string, string>,
): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const m of messages) {
    if (m.subtype) continue;
    const text = stripMention(m.text ?? "");
    if (text === "") continue;
    // bot_id だけでは他の bot と区別できない。自分の user id で判定する。
    const mine = Boolean(botUserId) && m.user === botUserId;
    // **誰の発言かを残す。** 潰すと複数人の会話が「1人が喋り続けている」ように見える
    const speaker = mine ? undefined : m.user ? (names?.get(m.user) ?? m.user) : undefined;
    turns.push({ role: mine ? "assistant" : "user", text, ...(speaker ? { speaker } : {}) });
  }
  return turns.slice(-MAX_RECOVERED_TURNS);
}

/** 自分がこのスレッドに参加しているか（発言しているか）。 */
export function hasOwnMessage(messages: SlackHistoryMessage[], botUserId?: string): boolean {
  return Boolean(botUserId) && messages.some((m) => m.user === botUserId);
}
