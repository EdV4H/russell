/**
 * 返信し忘れの拾い直し（積み残しの確認）。
 *
 * なぜ要るか: **Bob が黙るのは1つの原因ではない。** プロセスが落ちていた・再起動中だった・
 * Slack のイベントが届かなかった・ターンが例外で落ちた（隔離チェックなど）。どれも
 * 「相手は話しかけたのに返事が来ない」という同じ結果になる。個別に潰しても、
 * 次の原因が現れる。**結果の側から回復する**のがこの機能。
 *
 * ここは**判定だけの純関数**。Slack API を叩く部分（plugin.ts）と分けてあるのは、
 * 「返信が要るかどうか」の判定こそテストで固めたい部分だから——間違うと
 * 二重に返信するか、永久に返信しないかのどちらかになる。
 */

import type { SlackHistoryMessage } from "./conversation.js";
import { stripMention } from "./inbound.js";

/** 返信が要ると判定されたやりとり。 */
export interface PendingReply {
  /** 最後に来ていた発言（これに返す）。 */
  text: string;
  author: string;
  messageId?: string;
}

/** 発言として数えるもの（参加通知・編集などを除く）。 */
function conversational(m: SlackHistoryMessage): boolean {
  return !m.subtype && stripMention(m.text ?? "") !== "";
}

function isOwn(m: SlackHistoryMessage, botUserId?: string): boolean {
  return botUserId ? m.user === botUserId : Boolean(m.bot_id);
}

/**
 * このやりとりに返信が要るか判定する。
 *
 * 要件は3つで、**すべて満たすときだけ**返信が要る:
 * - **自分が関与している** — 一度も発言していないスレッドには入らない（呼ばれてもいない会話）。
 *   ただし最後の発言が自分宛の mention なら、関与していなくても対象にする（呼ばれた）
 * - **最後の発言が自分ではない** — 自分が最後なら返信は済んでいる
 * - **相手の発言が実体を持つ** — 空・subtype だけのものは無視
 *
 * 「自分が最後かどうか」で判定するので、**返信した時点で対象から外れる**。
 * 二重返信を防ぐための状態を別に持たなくてよい（べき等性が構造で出る）。
 */
export function pendingReply(
  messages: SlackHistoryMessage[],
  botUserId?: string,
): PendingReply | undefined {
  const usable = messages.filter(conversational);
  if (usable.length === 0) return undefined;

  const last = usable[usable.length - 1];
  if (!last || isOwn(last, botUserId)) return undefined;

  const involved = usable.some((m) => isOwn(m, botUserId));
  const addressed = botUserId ? (last.text ?? "").includes(`<@${botUserId}>`) : false;
  if (!involved && !addressed) return undefined;

  return {
    text: stripMention(last.text ?? ""),
    author: last.user ?? "unknown",
    messageId: last.ts,
  };
}

/**
 * その発言が窓の中か（古すぎないか）。
 *
 * 窓を切るのは、**起動のたびに何日も前のスレッドへ返信し始める**のを防ぐため。
 * 3日前の話に今さら返事をするのは、回復ではなく事故に見える。
 */
export function withinWindow(ts: string | undefined, since: Date): boolean {
  if (!ts) return false;
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return false;
  return seconds * 1000 >= since.getTime();
}
