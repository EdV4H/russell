/**
 * 引き受けた作業（ADR 0009）。env 不要。
 *
 * 作った動機は日報にある。「回答待ち」「まだ未読」「判断待ちのまま一日を終えた」が
 * 並んでいて、**Bob 自身は未完了を認識しているのに追う構造が無かった**。
 * メモ帳は TTL 7日で消え、索引カードは状態を持たない。
 *
 * ここで固めたいのは3つ: 引き受けたら残ること、**二重に作らないこと**、
 * 終わったら閉じられること。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import {
  type InboundMessage,
  MEMORY_SERVICE,
  type MemoryCapability,
  type ModelRequest,
  type RussellPlugin,
  type Temperament,
} from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

function scripted(decisions: string[], reply = "承知しました") {
  const requests: ModelRequest[] = [];
  let n = 0;
  const plugin: RussellPlugin = {
    id: "scripted",
    name: "scripted",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          requests.push(req);
          if (!req.system.includes("記憶係")) return { text: reply };
          return { text: decisions[n++] ?? decisions[decisions.length - 1] ?? "{}" };
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
        async react() {
          return { status: "succeeded" };
        },
      });
    },
  };
  const push = (text: string, contextId = "t1") =>
    sink?.({
      surfaceId: "fake",
      contextId,
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
      messageId: "m1",
    });
  return { plugin, push };
}

const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const TAKE = '{"todos":[{"content":"02のドキュメントを読む","waiting_for":null}]}';
const WAIT = '{"todos":[{"content":"配信単位の方針を決める","waiting_for":"丸山さん"}]}';
const NOTHING = '{"todos":[],"done":[]}';

async function agentWith(decisions: string[]) {
  const m = scripted(decisions);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  const todos = () => agent.ctx.services.get<MemoryCapability>(MEMORY_SERVICE)?.openTodos?.() ?? [];
  return { agent, requests: m.requests, push: s.push, todos };
}

test("引き受けたら残る", async () => {
  const { agent, push, todos } = await agentWith([TAKE]);
  push("02のドキュメント読んでおいてもらえる？");
  await drain();

  expect(await todos()).toMatchObject([{ content: "02のドキュメントを読む", state: "open" }]);
  await agent.destroy();
});

test("相手の返事待ちは待ち相手ごと残す（待っていること自体を忘れない）", async () => {
  const { agent, push, todos } = await agentWith([WAIT]);
  push("配信単位どうする？");
  await drain();

  expect(await todos()).toMatchObject([{ state: "waiting", waitingFor: "丸山さん" }]);
  await agent.destroy();
});

test("抱えている作業を判定に見せる（二重に作らせない）", async () => {
  const { agent, push, requests } = await agentWith([TAKE, NOTHING]);
  push("02読んでおいて");
  await drain();
  push("そういえば02の件どう？");
  await drain();

  const decisions = requests.filter((r) => r.system.includes("記憶係"));
  expect(decisions.at(-1)?.user).toContain("すでに抱えている作業");
  expect(decisions.at(-1)?.user).toContain("02のドキュメントを読む");
  await agent.destroy();
});

test("終わったら閉じる。消さずに状態を変える", async () => {
  const { agent, push, todos } = await agentWith([TAKE, '{"done":[1]}']);
  push("02読んでおいて");
  await drain();
  push("02読めた？");
  await drain();

  expect(await todos()).toEqual([]); // 未完了からは消える
  const closed = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked" && e.payload.tool === "todo.close");
  expect(closed).toHaveLength(1);
  await agent.destroy();
});

test("そのスレッドの作業だけが文脈に入る", async () => {
  const { agent, push, requests } = await agentWith([TAKE, NOTHING]);
  push("02読んでおいて", "t1");
  await drain();
  push("別の話です", "t2");
  await drain();

  const conversations = requests.filter((r) => !r.system.includes("記憶係"));
  expect(conversations.at(-1)?.system).not.toContain("02のドキュメントを読む");
  await agent.destroy();
});

test("同じスレッドなら文脈に入る", async () => {
  const { agent, push, requests } = await agentWith([TAKE, NOTHING]);
  push("02読んでおいて");
  await drain();
  push("さっきの件は？");
  await drain();

  const conversations = requests.filter((r) => !r.system.includes("記憶係"));
  expect(conversations.at(-1)?.system).toContain("このスレッドで抱えている作業");
  expect(conversations.at(-1)?.system).toContain("02のドキュメントを読む");
  await agent.destroy();
});

test("判定の指示: 自分が動くことだけを書く", async () => {
  const { agent, push, requests } = await agentWith([NOTHING]);
  push("やあ");
  await drain();

  const decision = requests.find((r) => r.system.includes("記憶係"))?.system ?? "";
  expect(decision).toContain("自分が動くこと");
  expect(decision).toContain("相手がやることは書かない");
  // 引き受けの言い回しを取りこぼさない
  expect(decision).toContain("「〜しておきます」");
  await agent.destroy();
});

test("1ターンの上限は5件", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ content: `作業${i}`, waiting_for: null }));
  const { agent, push, todos } = await agentWith([JSON.stringify({ todos: many })]);
  push("いろいろお願い");
  await drain();

  expect(await todos()).toHaveLength(5);
  await agent.destroy();
});
