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
 *   ただし**未応答の発言のどれかで名指しされていれば**、関与していなくても対象にする（呼ばれた）
 * - **最後の発言が自分ではない** — 自分が最後なら返信は済んでいる
 * - **相手の発言が実体を持つ** — 空・subtype だけのものは無視
 *
 * 「自分が最後かどうか」で判定するので、**返信した時点で対象から外れる**。
 * 二重返信を防ぐための状態を別に持たなくてよい（べき等性が構造で出る）。
 *
 * > [!IMPORTANT]
 * > **名指しは「最後の1件」ではなく「未応答の全部」で見る。** 初版は最後の発言しか
 * > 見ていなかったので、**呼ばれた直後に誰かが一言足すだけで呼びかけが消えた**。
 * > 実際にそれで取りこぼした——名指しの数十秒後に別の人が一言足しただけで
 * > 「返信は要らない」と判定された。呼ばれたことは、後続の発言では取り消されない。
 */
export function pendingReply(
  messages: SlackHistoryMessage[],
  botUserId?: string,
): PendingReply | undefined {
  const usable = messages.filter(conversational);
  if (usable.length === 0) return undefined;

  const last = usable[usable.length - 1];
  if (!last || isOwn(last, botUserId)) return undefined;

  // 自分が最後に喋った位置。**そこから後だけが「まだ答えていない分」**である
  let lastOwn = -1;
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i];
    if (m && isOwn(m, botUserId)) {
      lastOwn = i;
      break;
    }
  }
  const involved = lastOwn >= 0;
  // **答えた分まで遡らない。** 既に返事をした呼びかけで、もう一度呼ばれたことにしない
  const unanswered = usable.slice(lastOwn + 1);
  const addressed = botUserId
    ? unanswered.some((m) => (m.text ?? "").includes(`<@${botUserId}>`))
    : false;
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

/**
 * やりとりの単位を、チャンネルの履歴から見つける。
 *
 * **2つ拾う。** どちらも「返事を待っている人がいる」形なのに、片方しか見ていなかった。
 *
 * 1. **スレッド** — 自分が関与している続き。**親が窓の外でも、返信が窓の中なら拾う**
 *    （`latest_reply` を見る）。親の時刻で切ると、**古いスレッドへの新しい返信**が
 *    永久に拾えない——返信し忘れの本命がそこなのに
 * 2. **チャンネル直下の名指し** — `@Bob …` とだけ書かれた発言。スレッドではないので
 *    1 では見つからない。実際、これで**2時間半前の呼びかけを取りこぼした**
 *
 * 直下の発言を**名指しのときだけ**拾うのは、通常の追従と同じ線引き（§13）。
 * 名指しでない雑談まで拾うと「全部読んでいる」になる。
 */
export function findContexts(
  channel: string,
  history: SlackHistoryMessage[],
  since: Date,
  botUserId?: string,
): string[] {
  const contexts = new Set<string>();
  for (const m of history) {
    if (m.subtype) continue;
    // スレッド（親・返信のどちらから来ても根で畳まれる）
    if (m.thread_ts) {
      // **最後の動きで判断する。** 親の時刻ではない
      if (withinWindow(m.latest_reply ?? m.ts, since)) contexts.add(`${channel}:${m.thread_ts}`);
      continue;
    }
    // チャンネル直下。**名指しだけ**拾う（呼ばれたものには答える）
    const addressed = botUserId ? (m.text ?? "").includes(`<@${botUserId}>`) : false;
    if (addressed && withinWindow(m.ts, since)) contexts.add(`${channel}:${m.ts}`);
  }
  return [...contexts];
}

/**
 * > [!IMPORTANT]
 * > **`oldest` で遡ってはいけない。**
 * >
 * > 初版は `conversations.history` に `oldest`（14日前）と `limit`（20）を同時に渡していた。
 * > Slack はこのとき **`oldest` から古い順に** 20件を返す——「直近20件」ではない。
 * > つまり積み残しの確認は、**チャンネルの逆の端**（14日前あたりの20件）だけを見ていて、
 * > 今日の発言は一度も視界に入っていなかった。
 * >
 * > 当時のコメントは「遡る期間を広げても API の負荷は変わらない」と書いてあり、
 * > 負荷については正しいが、**広げるほど見える窓が過去へ押し出される**ことを見落としていた。
 * > 2つのパラメータが打ち消し合っていて、しかも**エラーは出ない**——
 * > 「0件」とだけ報告され続けた。
 * >
 * > いまは `oldest` を渡さず、**新しい方から**取る。親が古いスレッドは
 * > `findContexts` が `latest_reply` で拾うので、遡る必要はもともと無かった。
 */

/** 探すのに必要なものだけ。**実クライアントを持ち込まない**ので、そのままテストできる。 */
export interface PendingSearchDeps {
  since: Date;
  limit: number;
  botUserId?: string;
  allowedChannels?: ReadonlySet<string>;
  excludedChannels?: ReadonlySet<string>;
  listConversations(): Promise<{ id?: string; isDm: boolean }[]>;
  /** そのチャンネルの**直近**の発言（新しい方から）。**`oldest` で遡らない**（上記）。 */
  history(channel: string): Promise<SlackHistoryMessage[]>;
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
/**
 * 読めなかった理由に、**どの会話か**を添える（#121）。
 *
 * 理由だけだと「毎回1件読めない」までしか分からず、直せるものかどうかも、
 * それが**大事な会話なのか**も言えない。実際、読めないチャンネルがあることは
 * 毎回ログに出ていたのに、**そこが主戦場のチャンネルかもしれない**ことに気づけなかった。
 *
 * 出すのは id だけ。**本文は出さない**（A1-5）。
 */
function skipNote(err: unknown, channel: string): string {
  return `${slackReason(err)}(${channel})`;
}

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

export async function findPendingMessages(deps: PendingSearchDeps): Promise<{
  found: InboundMessage[];
  skipped: number;
  reasons: string[];
  /**
   * 設定で**見に行かなかった**会話の数。
   *
   * 読めなかった数は報告していたのに、**見に行かないと決めた分は数えていなかった**。
   * だから「0件」が「無い」とも「30会話のうち1つしか見ていない」とも読めた——
   * 判断はしているのに、判断の材料を捨てている。
   */
  filtered: number;
}> {
  const found: InboundMessage[] = [];
  let skipped = 0;
  let filtered = 0;
  /** 読めなかった理由（重複は畳む）。**本文ではないので監査にもログにも出してよい**。 */
  const reasons = new Set<string>();
  // **スレッドを見つける窓は、返信の窓より広く取る。** 親が古いスレッドは、
  // 窓を親の時刻で切ると一生現れない。拾うかどうかは `findContexts` が
  // 最後の動きで判断するので、ここを広げても古い話に返信し始めることはない。
  // **自分が誰か分からないまま探さない。** 名指しの判定ができないので、
  // 静かに「0件」を報告することになる（実際にそれで取りこぼした）。
  // 数だけ合っていて中身が欠けている状態を、黙って通さない。
  if (!deps.botUserId) {
    return { found: [], skipped: 0, reasons: ["自分の id が分からない"], filtered: 0 };
  }
  for (const convo of await deps.listConversations()) {
    if (found.length >= deps.limit) break;
    const channel = convo.id;
    if (!channel) continue;
    if (!convo.isDm && deps.excludedChannels?.has(channel)) {
      filtered++;
      continue;
    }
    if (!convo.isDm && deps.allowedChannels && !deps.allowedChannels.has(channel)) {
      filtered++;
      continue;
    }

    let history: SlackHistoryMessage[];
    try {
      history = await deps.history(channel);
    } catch (err) {
      skipped++;
      reasons.add(skipNote(err, channel));
      continue;
    }

    // やりとりの単位。DM はチャンネル直下、チャンネルはスレッドと**直下の名指し**（ADR 0002）
    const contexts = convo.isDm
      ? [`${channel}:`]
      : findContexts(channel, history, deps.since, deps.botUserId);

    for (const contextId of contexts) {
      if (found.length >= deps.limit) break;
      let thread: SlackHistoryMessage[];
      try {
        thread = await deps.messages(contextId);
      } catch (err) {
        skipped++;
        reasons.add(skipNote(err, contextId));
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
  return { found, skipped, reasons: [...reasons], filtered };
}
