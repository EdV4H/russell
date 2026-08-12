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

/** id → 表示名。引けなかった id は含まれない。 */
export type NameBook = ReadonlyMap<string, string>;

/**
 * mention を**人が見ているのと同じ形**に直す。
 *
 * 以前は `<@U…>` を無条件に落としていた。その結果:
 * - **文が壊れた**——「今日からチームに入ってもらう\<@U_BOB\>くんです」→「…もらうくんです」
 * - **同席者が消えた**——`@A-san @B-san` に紹介されたのに、1対1と区別がつかない
 *
 * Slack の画面では `@丸山` と表示されている。**個体にも同じものを見せる**のが素直で、
 * 文の構造も壊れない。
 *
 * 引けなかった id は `@U123` のまま残す。**消すと文が壊れ、名前を当てると嘘になる**ので、
 * 「誰か分からない人がいる」と分かる形にしておく（人格プロンプト側で「知らない名前を
 * 作らない」と縛ってある）。
 */
export function renderMentions(text: string, names: NameBook): string {
  return text
    .replace(/<@([^>|\s]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${names.get(id) ?? id}`)
    .trim();
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
export function fromAppMention(e: SlackMentionEvent, names: NameBook = new Map()): InboundMessage {
  return {
    surfaceId: "slack",
    contextId: toContextId(e.channel, e.thread_ts ?? e.ts),
    author: e.user ?? "unknown",
    // **記録は id、会話には名前**。id は安定した識別子なので監査はそちらを使う
    authorName: e.user ? names.get(e.user) : undefined,
    text: renderMentions(e.text ?? "", names),
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
export function fromDirectMessage(
  m: SlackMessageEvent,
  names: NameBook = new Map(),
): InboundMessage | undefined {
  if (m.channel_type !== "im") return undefined;
  if (m.bot_id || m.subtype) return undefined;
  if (typeof m.text !== "string" || m.text.trim() === "") return undefined;
  if (!m.channel || !m.ts) return undefined;
  return {
    surfaceId: "slack",
    contextId: toContextId(m.channel, m.thread_ts),
    author: m.user ?? "unknown",
    authorName: m.user ? names.get(m.user) : undefined,
    text: renderMentions(m.text, names),
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
   * 除外するチャンネル（ID）。ここに入れたチャンネルは、招待されていても追従しない。
   * 機微なチャンネルに居させたいが会話には入ってほしくない、という場合の逃げ道。
   */
  excludedChannels?: ReadonlySet<string>;
  /**
   * 厳格モード。指定するとこのチャンネルだけに絞る（既定は指定なし＝招待されたチャンネル全部）。
   *
   * **opt-in の実体は Slack の招待。** privacy-and-memory-policy の「明示的に招待され」が
   * それにあたり、Slack は参加していないチャンネルのイベントをそもそも配らない。
   * 一方この allowlist は**データの到着を止めていない**（購読は種類単位でしか絞れないため、
   * 参加チャンネルの発言は指定の有無に関わらず届く）ので、招待以上の安全は買えない。
   * 招待のたびに設定と再起動を強いる割に得るものが無いので、既定にはしない。
   */
  allowedChannels?: ReadonlySet<string>;
  /** Bob が既に発言したスレッド（contextId）。会話の続きだけを拾うための目印。 */
  activeThreads: ReadonlySet<string>;
  /** 自分の bot user id。mention は app_mention 側が拾うので、ここでは二重に処理しない。 */
  botUserId?: string;
  /** id → 表示名。**人が見ているのと同じ形**を個体にも見せるために使う。 */
  names?: NameBook;
}

/**
 * チャンネルの発言（`message.channels` / `message.groups`）。
 * **拾うのは「Bob が参加しているスレッドの続き」だけ**で、それ以外は捨てる。
 *
 * 捨てる理由が3種類あるので順に:
 * - 除外指定のチャンネル（または厳格モードの allowlist 外） … 入ってほしくない場所には入らない
 * - スレッド外の発言 … チャンネルの雑談を拾い始めると「全部読んでいる」になる
 * - Bob がまだ発言していないスレッド … 呼ばれてもいない会話に入っていかない
 *
 * mention を含む発言は `app_mention` でも届くので、ここでは捨てる（両方処理すると2回返信する）。
 */
export function fromChannelMessage(
  m: SlackMessageEvent,
  ctx: ChannelFollowContext,
): InboundMessage | undefined {
  const result = inspectChannelMessage(m, ctx);
  return result.accepted;
}

/** 捨てた理由。**無反応の理由を後から言えるようにする**ためにコード化してある。 */
export type ChannelDropReason =
  | "not_a_channel_message"
  | "bot_or_subtype"
  | "empty_text"
  | "missing_ids"
  | "excluded_channel"
  | "not_in_allowlist"
  | "not_in_thread"
  | "handled_by_app_mention"
  | "thread_not_joined";

export interface ChannelInspection {
  accepted?: InboundMessage;
  dropped?: ChannelDropReason;
}

/**
 * `fromChannelMessage` の中身。採用/不採用と**その理由**を返す。
 *
 * 理由を返すのは、届いていないのか捨てたのかを外から言えるようにするため。
 * 「反応しない」ときに切り分けられないのが一番つらい（実地で踏んだ）。
 */
export function inspectChannelMessage(
  m: SlackMessageEvent,
  ctx: ChannelFollowContext,
): ChannelInspection {
  if (m.channel_type !== "channel" && m.channel_type !== "group")
    return { dropped: "not_a_channel_message" };
  if (m.bot_id || m.subtype) return { dropped: "bot_or_subtype" };
  if (typeof m.text !== "string" || m.text.trim() === "") return { dropped: "empty_text" };
  if (!m.channel || !m.ts) return { dropped: "missing_ids" };
  if (ctx.excludedChannels?.has(m.channel)) return { dropped: "excluded_channel" };
  if (ctx.allowedChannels && !ctx.allowedChannels.has(m.channel))
    return { dropped: "not_in_allowlist" };
  if (!m.thread_ts) return { dropped: "not_in_thread" };
  if (ctx.botUserId && m.text.includes(`<@${ctx.botUserId}>`))
    return { dropped: "handled_by_app_mention" };

  const contextId = toContextId(m.channel, m.thread_ts);
  if (!ctx.activeThreads.has(contextId)) return { dropped: "thread_not_joined" };

  return {
    accepted: {
      surfaceId: "slack",
      contextId,
      author: m.user ?? "unknown",
      text: m.text,
      trustLabel: "untrusted",
      isMention: true, // 自分が参加しているスレッドの続き＝自分への発話として扱う
      messageId: m.ts,
    },
  };
}

function idsFromEnv(raw: string | undefined): Set<string> | undefined {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
}

/** 除外チャンネル（env `RUSSELL_SLACK_EXCLUDE_CHANNELS`、カンマ区切り）。未設定なら除外なし。 */
export function excludedChannelsFromEnv(
  raw = process.env.RUSSELL_SLACK_EXCLUDE_CHANNELS,
): Set<string> | undefined {
  return idsFromEnv(raw);
}

/**
 * 厳格モードの allowlist（env `RUSSELL_SLACK_CHANNELS`、カンマ区切り）。
 * **未設定が既定** ＝ 招待されたチャンネルすべてで追従する。
 */
export function allowedChannelsFromEnv(
  raw = process.env.RUSSELL_SLACK_CHANNELS,
): Set<string> | undefined {
  return idsFromEnv(raw);
}
