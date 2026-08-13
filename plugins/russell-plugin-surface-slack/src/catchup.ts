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

import type { InboundMessage } from "@edv4h/russell-shared";
import type { SlackHistoryMessage } from "./conversation.js";
import { stripMention } from "./inbound.js";

/** 返信が要ると判定されたやりとり。 */
export interface PendingReply {
  /** 最後に来ていた発言（これに返す）。 */
  text: string;
  author: string;
  messageId?: string;
  /** その発言が自分を名指ししていたか。**返すかどうかの判断に使う**（拾うかとは別）。 */
  mentionsBot: boolean;
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
    mentionsBot: addressed,
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

/** 探すのに必要なものだけ。**実クライアントを持ち込まない**ので、そのままテストできる。 */
export interface PendingSearchDeps {
  since: Date;
  limit: number;
  botUserId?: string;
  allowedChannels?: ReadonlySet<string>;
  excludedChannels?: ReadonlySet<string>;
  listConversations(): Promise<{ id?: string; isDm: boolean }[]>;
  history(channel: string, oldest: string): Promise<SlackHistoryMessage[]>;
  messages(contextId: string): Promise<SlackHistoryMessage[]>;
  names(text: string, author?: string): Promise<Map<string, string>>;
  onJoined?(contextId: string): void;
}

/**
 * 返信し忘れているやりとりを探す。
 *
 * **1つ読めないだけで全部止めない。** 実データでは読めない会話が必ず混ざる
 * （アーカイブ、消えたチャンネル、削除済みユーザーとの DM）。実際 `channel_not_found` で
 * 確認が丸ごと止まっていた。0件が「無い」なのか「見られなかった」なのかは別物なので、
 * 読めなかった数は必ず報告する。
 *
 * **理由も返す。** 数だけだと「毎回1件読めない」が権限不足なのか消えたチャンネルなのか
 * 分からず、直せるものなのかどうかも判断できない（実際、毎回の起動で1件出続けていた）。
 */
/**
 * Slack の失敗を、直せるかどうかが分かる短い語にする。
 *
 * `missing_scope` は**こちらで直せる**（権限を足す）。`channel_not_found` は
 * だいたい直せない（抜けた・消えた）。この区別が付かないと、毎回出る警告を
 * 見なかったことにするしかなくなる。
 */
function slackReason(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const known = [
    "missing_scope",
    "not_in_channel",
    "channel_not_found",
    "is_archived",
    "account_inactive",
    "ratelimited",
    "invalid_auth",
  ].find((code) => detail.includes(code));
  return known ?? "不明";
}

export async function findPendingMessages(
  deps: PendingSearchDeps,
): Promise<{ found: InboundMessage[]; skipped: number; reasons: string[] }> {
  const found: InboundMessage[] = [];
  let skipped = 0;
  /** 読めなかった理由（重複は畳む）。**本文ではないので監査にもログにも出してよい**。 */
  const reasons = new Set<string>();
  const oldest = String(Math.floor(deps.since.getTime() / 1000));

  for (const convo of await deps.listConversations()) {
    if (found.length >= deps.limit) break;
    const channel = convo.id;
    if (!channel) continue;
    if (!convo.isDm && deps.excludedChannels?.has(channel)) continue;
    if (!convo.isDm && deps.allowedChannels && !deps.allowedChannels.has(channel)) continue;

    let history: SlackHistoryMessage[];
    try {
      history = await deps.history(channel, oldest);
    } catch (err) {
      skipped++;
      reasons.add(slackReason(err));
      continue;
    }

    // やりとりの単位。DM はチャンネル直下、チャンネルはスレッド単位（ADR 0002）
    const contexts = convo.isDm
      ? [`${channel}:`]
      : [
          ...new Set(
            history
              // biome-ignore lint/suspicious/noExplicitAny: history の生要素。thread_ts は型に無い
              .map((m) => (m as any).thread_ts as string | undefined)
              .filter((t): t is string => Boolean(t)),
          ),
        ].map((t) => `${channel}:${t}`);

    for (const contextId of contexts) {
      if (found.length >= deps.limit) break;
      let thread: SlackHistoryMessage[];
      try {
        thread = await deps.messages(contextId);
      } catch (err) {
        skipped++;
        reasons.add(slackReason(err));
        continue;
      }
      const pending = pendingReply(thread, deps.botUserId);
      // 古すぎるものは拾わない。3日前の話に今さら返すのは回復ではなく事故に見える
      if (!pending || !withinWindow(pending.messageId, deps.since)) continue;

      const names = await deps.names(pending.text, pending.author).catch(() => new Map());
      found.push({
        surfaceId: "slack",
        contextId,
        author: pending.author,
        authorName: names.get(pending.author),
        people: [...names].map(([id, name]) => ({ id, name })),
        text: pending.text,
        trustLabel: "untrusted",
        // ここも正直に付ける。**黙ると決めた発言に、後から返信し直さない**ため
        isMention: pending.mentionsBot,
        messageId: pending.messageId,
      });
      if (!convo.isDm) deps.onJoined?.(contextId);
    }
  }
  return { found, skipped, reasons: [...reasons] };
}
