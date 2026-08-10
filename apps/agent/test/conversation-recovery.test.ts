/**
 * 再起動をまたいで会話に戻れること（ADR 0001）。env・トークン不要。
 *
 * 短期記憶はプロセス内にしかないので再起動で消える。保存する代わりに、必要になった
 * 時点で通信面から取り直す。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { hasOwnMessage, toTurns } from "@edv4h/russell-plugin-surface-slack";
import type {
  ConversationCapability,
  InboundMessage,
  ModelRequest,
  ModelTurn,
  RussellPlugin,
  Temperament,
} from "@edv4h/russell-shared";
import { CONVERSATION_SERVICE } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

function recordingModel() {
  const requests: ModelRequest[] = [];
  const plugin: RussellPlugin = {
    id: "recording-model",
    name: "recording model",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          if (req.system.includes("記憶係")) return { text: "{}" };
          requests.push(req);
          return { text: "はい" };
        },
      });
    },
  };
  return { plugin, requests };
}

function surface() {
  let sink: ((m: InboundMessage) => void) | undefined;
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake surface",
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
  const push = (text: string) =>
    sink?.({
      surfaceId: "fake",
      contextId: "C1:100.1",
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, push };
}

/** 通信面が持つ「取り直す」実装の代役。呼ばれた回数も見る。 */
function conversationSource(turns: ModelTurn[]) {
  const state = { calls: 0 };
  const plugin: RussellPlugin = {
    id: "fake-conversation",
    name: "fake conversation source",
    setup(ctx) {
      ctx.services.provide<ConversationCapability>(CONVERSATION_SERVICE, {
        async history() {
          state.calls += 1;
          return turns;
        },
      });
    },
  };
  return { plugin, state };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

test("手元に会話が無ければ通信面から取り直す（再起動後の1発目）", async () => {
  const m = recordingModel();
  const s = surface();
  const c = conversationSource([
    { role: "user", text: "金曜の定例どうする？" },
    { role: "assistant", text: "資料を用意します" },
  ]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), c.plugin, m.plugin, s.plugin],
  );

  s.push("それ、誰に頼む？");
  await drain();

  // 再起動直後でも流れを踏まえられる
  expect(m.requests[0]?.history?.map((t) => t.text)).toEqual([
    "金曜の定例どうする？",
    "資料を用意します",
  ]);
  // 復元したことは監査に残る（本文は入れない）
  const rec = agent.ctx.audit.recent().find((e) => e.action === "conversation.recovered");
  expect(rec?.payload).toMatchObject({ contextId: "C1:100.1", turns: 2 });
  expect(JSON.stringify(rec?.payload)).not.toContain("金曜");

  // 2発目は手元にあるので取り直さない
  s.push("わかった");
  await drain();
  expect(c.state.calls).toBe(1);
  expect(m.requests[1]?.history?.at(-1)?.text).toBe("はい");

  await agent.destroy();
});

test("取得物の末尾に今回の発言が入っていても二重にしない", async () => {
  const m = recordingModel();
  const s = surface();
  // 通信面から見れば今回の発言も既に投稿済みなので、末尾に入りうる
  const c = conversationSource([
    { role: "user", text: "前の話" },
    { role: "assistant", text: "はい" },
    { role: "user", text: "いまの発言" },
  ]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), c.plugin, m.plugin, s.plugin],
  );

  s.push("いまの発言");
  await drain();

  expect(m.requests[0]?.history?.map((t) => t.text)).toEqual(["前の話", "はい"]);
  expect(m.requests[0]?.user).toBe("いまの発言");

  await agent.destroy();
});

test("取り直せなくても会話は続ける（流れを踏まえられないだけ）", async () => {
  const m = recordingModel();
  const s = surface();
  const failing: RussellPlugin = {
    id: "failing-conversation",
    name: "failing",
    setup(ctx) {
      ctx.services.provide<ConversationCapability>(CONVERSATION_SERVICE, {
        async history() {
          throw new Error("Slack 障害");
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), failing, m.plugin, s.plugin],
  );

  s.push("こんにちは");
  await drain();

  expect(m.requests[0]?.history).toEqual([]);
  expect(m.requests.length).toBe(1); // 応答自体は行われる
  await agent.destroy();
});

test("Slack の発言列の解釈: 自分の発言は assistant、他は user", () => {
  const messages = [
    { user: "U1", text: "<@UBOB> 金曜の定例どうする？", ts: "1" },
    { user: "UBOB", text: "資料を用意します", ts: "2" },
    { user: "U2", text: "参加します", ts: "3" },
    { user: "U3", text: "", ts: "4" }, // 空文字は落とす
    { user: "U4", text: "入室しました", subtype: "channel_join", ts: "5" }, // subtype も落とす
  ];
  expect(toTurns(messages, "UBOB")).toEqual([
    { role: "user", text: "金曜の定例どうする？" }, // mention 記法は落とす
    { role: "assistant", text: "資料を用意します" },
    { role: "user", text: "参加します" },
  ]);
});

test("自分が発言していないスレッドは参加とみなさない", () => {
  const others = [
    { user: "U1", text: "内輪の話", ts: "1" },
    { user: "U2", text: "そうだね", ts: "2" },
  ];
  expect(hasOwnMessage(others, "UBOB")).toBe(false);
  expect(hasOwnMessage([...others, { user: "UBOB", text: "呼ばれました", ts: "3" }], "UBOB")).toBe(
    true,
  );
  // bot user id が分からないときは参加とみなさない（誤って他人の会話に入らない）
  expect(hasOwnMessage(others, undefined)).toBe(false);
});
