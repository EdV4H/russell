/**
 * mention を人が見ているのと同じ形にする（A/B/C）。env 不要。
 *
 * 実際に紹介文を流して分かったこと:
 * - `@Bobくん` が「くん」になり、**日本語が壊れた**
 * - `@A-san @B-san` が消え、**同席者が分からなくなった**
 * - 相手が誰か分からないまま丁寧に振る舞おうとして、**存在しない名前を作った**
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { fromAppMention, mentionedIds, renderMentions } from "@edv4h/russell-plugin-surface-slack";
import type {
  InboundMessage,
  ModelRequest,
  RussellPlugin,
  Temperament,
} from "@edv4h/russell-shared";
import { expect, test } from "vitest";
import { scriptedModel } from "./memory-model.js";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

const NAMES = new Map([
  ["U_BOB", "Bob"],
  ["U_A", "A-san"],
  ["U_LEAD", "丸山"],
]);

const INTRO =
  "<@U_BOB> <@U_A> 今日からチームに入ってもらう<@U_BOB>くんです！新人としてしっかり働いてもらいます！";

test("文中の mention が名前になり、文が壊れない", () => {
  const rendered = renderMentions(INTRO, NAMES);

  // 以前は「…もらうくんです」になっていた
  expect(rendered).toContain("入ってもらう@Bobくんです");
  expect(rendered).not.toContain("<@");
});

test("同席者が残る（誰がいる場か分かる）", () => {
  expect(renderMentions(INTRO, NAMES)).toContain("@A-san");
});

test("引けなかった id は消さず、名前も当てない", () => {
  // **消すと文が壊れ、当てると嘘になる。** 「分からない人がいる」と分かる形にする
  const rendered = renderMentions("<@U_UNKNOWN> これお願い", new Map());
  expect(rendered).toBe("@U_UNKNOWN これお願い");
});

test("表示名つきの記法（<@U|name>）も扱える", () => {
  expect(renderMentions("<@U_A|old-name> どう？", NAMES)).toBe("@A-san どう？");
});

test("引く対象の id を拾える（発言者は別途足す）", () => {
  expect(mentionedIds(INTRO)).toEqual(["U_BOB", "U_A", "U_BOB"]);
  expect(mentionedIds("mention なし")).toEqual([]);
});

test("記録は id、会話には名前", () => {
  const msg = fromAppMention({ channel: "C1", ts: "1", user: "U_LEAD", text: INTRO }, NAMES);

  // 監査は安定した識別子を使う
  expect(msg.author).toBe("U_LEAD");
  // 会話では名前
  expect(msg.authorName).toBe("丸山");
});

test("名前が引けたら、誰と話しているかを文脈に入れる", async () => {
  const m = scriptedModel(undefined, "はじめまして");
  let sink: ((msg: InboundMessage) => void) | undefined;
  const surface: RussellPlugin = {
    id: "fake",
    name: "fake",
    setup(ctx) {
      return ctx.surfaces.register({
        id: "fake",
        start(s) {
          sink = s;
        },
        async send() {
          return { status: "succeeded" };
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, surface],
  );

  sink?.({
    surfaceId: "fake",
    contextId: "t1",
    author: "U_LEAD",
    authorName: "丸山",
    text: "はじめまして",
    trustLabel: "untrusted",
    isMention: true,
    messageId: "m1",
  });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  expect(m.conversations[0]?.system).toContain("いま話している相手: 丸山");
  await agent.destroy();
});

test("名前が無ければ、相手の行を入れない（埋めない）", async () => {
  const m = scriptedModel(undefined, "はじめまして");
  let sink: ((msg: InboundMessage) => void) | undefined;
  const surface: RussellPlugin = {
    id: "fake",
    name: "fake",
    setup(ctx) {
      return ctx.surfaces.register({
        id: "fake",
        start(s) {
          sink = s;
        },
        async send() {
          return { status: "succeeded" };
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, surface],
  );

  sink?.({
    surfaceId: "fake",
    contextId: "t1",
    author: "U_LEAD",
    text: "はじめまして",
    trustLabel: "untrusted",
    isMention: true,
    messageId: "m1",
  });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  expect(m.conversations[0]?.system).not.toContain("いま話している相手");
  // 代わりに「知らない名前を作らない」と縛ってある
  expect(m.conversations[0]?.system).toContain("知らない名前を作らない");
  await agent.destroy();
});
