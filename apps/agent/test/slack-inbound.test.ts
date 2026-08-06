/**
 * Slack 受信の正規化（env・トークン不要）。§10 / §12-3。
 *
 * ここは surface-slack で唯一「解釈」をする場所で、間違えると記憶の紐づけが壊れるか、
 * 自分の発言に返事を続ける。トークンが無いと試せない、では困るので純関数にしてある。
 */

import {
  fromAppMention,
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
