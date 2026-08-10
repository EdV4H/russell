/**
 * Slack 受信の正規化（env・トークン不要）。§10 / §12-3。
 *
 * ここは surface-slack で唯一「解釈」をする場所で、間違えると記憶の紐づけが壊れるか、
 * 自分の発言に返事を続ける。トークンが無いと試せない、では困るので純関数にしてある。
 */

import {
  allowedChannelsFromEnv,
  fromAppMention,
  fromChannelMessage,
  fromDirectMessage,
  parseContextId,
  toContextId,
} from "@edv4h/russell-plugin-surface-slack";
import { expect, test } from "vitest";

test("mention はスレッド単位。スレッド外なら自分の ts が根になる", () => {
  const first = fromAppMention({ channel: "C1", ts: "100.1", user: "U1", text: "<@BOB> やあ" });
  expect(first).toEqual({
    surfaceId: "slack",
    contextId: "C1:100.1",
    author: "U1",
    text: "やあ",
    trustLabel: "untrusted",
    isMention: true,
    messageId: "100.1",
  });

  // 同じスレッドへの2発目は contextId が揃う（記憶が同じ文脈に載る）
  const second = fromAppMention({
    channel: "C1",
    ts: "100.9",
    thread_ts: "100.1",
    user: "U1",
    text: "<@BOB> あれどうなった",
  });
  expect(second.contextId).toBe("C1:100.1");
  expect(second.messageId).toBe("100.9"); // リアクションは発言ごとに付ける
});

test("DM の連続した発言は同じ contextId になる（#29 の回帰）", () => {
  const a = fromDirectMessage({
    channel: "D1",
    channel_type: "im",
    ts: "1.1",
    user: "U1",
    text: "覚えておいて",
  });
  const b = fromDirectMessage({
    channel: "D1",
    channel_type: "im",
    ts: "2.2",
    user: "U1",
    text: "それ何だっけ",
  });

  // ts を contextId に混ぜていた頃は D1:1.1 と D1:2.2 に割れ、DM では想起が効かなかった
  expect(a?.contextId).toBe("D1:");
  expect(b?.contextId).toBe("D1:");
  expect(a?.messageId).toBe("1.1");
});

test("DM でも bot 自身の発言は拾わない（自分に返事を続けない）", () => {
  const own = fromDirectMessage({
    channel: "D1",
    channel_type: "im",
    ts: "3.3",
    text: "覚えておきますね。",
    bot_id: "B1",
  });
  expect(own).toBeUndefined();
});

test("編集・削除・空文字・チャンネル発言は受け付けない", () => {
  const base = { channel: "D1", channel_type: "im", ts: "4.4", user: "U1" };
  expect(
    fromDirectMessage({ ...base, text: "直した", subtype: "message_changed" }),
  ).toBeUndefined();
  expect(fromDirectMessage({ ...base, text: "   " })).toBeUndefined();
  expect(fromDirectMessage({ ...base })).toBeUndefined();
  // チャンネルの発言は mention 経路だけで拾う（message.channels 全読みは P0 スコープ外）
  expect(fromDirectMessage({ ...base, channel_type: "channel", text: "雑談" })).toBeUndefined();
});

test("contextId は channel と thread に往復できる。DM は thread が空", () => {
  expect(parseContextId(toContextId("C1", "100.1"))).toEqual({ channel: "C1", thread: "100.1" });
  // 空スレッド = チャンネル直下。送信側はこれを見て thread_ts を付けない
  expect(parseContextId(toContextId("D1", undefined))).toEqual({ channel: "D1", thread: "" });
  // 区切りが無い古い形式でも channel として解釈する
  expect(parseContextId("C9")).toEqual({ channel: "C9", thread: "" });
});

test("スレッド追従: 参加しているスレッドの続きだけを拾う", () => {
  const ctx = {
    allowedChannels: new Set(["C1"]),
    activeThreads: new Set(["C1:100.1"]), // Bob が発言済みのスレッド
    botUserId: "UBOB",
  };
  const base = { channel: "C1", channel_type: "channel", ts: "100.5", user: "U1" };

  // Bob が参加しているスレッドの続き → 拾う（mention 不要）
  expect(fromChannelMessage({ ...base, thread_ts: "100.1", text: "で、どうする？" }, ctx)).toEqual({
    surfaceId: "slack",
    contextId: "C1:100.1",
    author: "U1",
    text: "で、どうする？",
    trustLabel: "untrusted",
    isMention: true,
    messageId: "100.5",
  });

  // 参加していないスレッド → 呼ばれてもいない会話に入っていかない
  expect(
    fromChannelMessage({ ...base, thread_ts: "999.9", text: "内輪の話" }, ctx),
  ).toBeUndefined();
  // スレッド外の発言 → チャンネルの雑談は拾わない
  expect(fromChannelMessage({ ...base, text: "雑談" }, ctx)).toBeUndefined();
});

test("スレッド追従: opt-in していないチャンネルは読まない", () => {
  const msg = {
    channel: "C-OTHER",
    channel_type: "channel",
    ts: "1.1",
    thread_ts: "1.0",
    text: "…",
  };
  // allowlist に無い
  expect(
    fromChannelMessage(msg, {
      allowedChannels: new Set(["C1"]),
      activeThreads: new Set(["C-OTHER:1.0"]),
    }),
  ).toBeUndefined();
  // allowlist が空＝設定漏れ。「全部読む」に倒れない
  expect(
    fromChannelMessage(msg, {
      allowedChannels: new Set(),
      activeThreads: new Set(["C-OTHER:1.0"]),
    }),
  ).toBeUndefined();
  expect(allowedChannelsFromEnv("")).toEqual(new Set());
  expect(allowedChannelsFromEnv("C1, C2")).toEqual(new Set(["C1", "C2"]));
});

test("スレッド追従: mention 入りは app_mention に任せる（2回返信しない）", () => {
  const ctx = {
    allowedChannels: new Set(["C1"]),
    activeThreads: new Set(["C1:100.1"]),
    botUserId: "UBOB",
  };
  const base = {
    channel: "C1",
    channel_type: "channel",
    ts: "100.6",
    thread_ts: "100.1",
    user: "U1",
  };

  // mention を含む発言は app_mention でも届くので、こちらでは捨てる
  expect(fromChannelMessage({ ...base, text: "<@UBOB> これお願い" }, ctx)).toBeUndefined();
  // 他人への mention は関係ないので拾う
  expect(fromChannelMessage({ ...base, text: "<@UOTHER> どう思う？" }, ctx)?.text).toBe(
    "<@UOTHER> どう思う？",
  );
});

test("スレッド追従: bot 自身の発言と編集は拾わない", () => {
  const ctx = { allowedChannels: new Set(["C1"]), activeThreads: new Set(["C1:100.1"]) };
  const base = { channel: "C1", channel_type: "channel", ts: "100.7", thread_ts: "100.1" };
  expect(
    fromChannelMessage({ ...base, text: "覚えておきますね。", bot_id: "B1" }, ctx),
  ).toBeUndefined();
  expect(
    fromChannelMessage({ ...base, text: "直した", subtype: "message_changed" }, ctx),
  ).toBeUndefined();
  // プライベートチャンネル（group）も同じ扱いで拾う
  expect(fromChannelMessage({ ...base, channel_type: "group", text: "続き" }, ctx)?.contextId).toBe(
    "C1:100.1",
  );
});
