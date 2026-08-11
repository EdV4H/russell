/**
 * 個人カルテ（索引カード, ADR 0008）。env 不要。
 *
 * **器を作ること自体が危ない機能**である。privacy-and-memory-policy が「書かない」と定める
 * 筆頭が個人の能力評価で、それは決定論フィルタでは止まらない（#54）。
 * だからここで固めたいのは保存の仕組みより、**何を書かないかが指示に入っていること**と、
 * **公開経路に出ないこと**の2つ。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type {
  InboundMessage,
  ModelRequest,
  RussellPlugin,
  Temperament,
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

function scripted(decision: string, reply = "わかりました") {
  const requests: ModelRequest[] = [];
  const plugin: RussellPlugin = {
    id: "scripted",
    name: "scripted",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          requests.push(req);
          return { text: req.system.includes("記憶係") ? decision : reply };
        },
      });
    },
  };
  return { plugin, requests };
}

function surface() {
  const sent: string[] = [];
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
        async send(o) {
          sent.push(o.text);
          return { status: "succeeded" };
        },
        async react() {
          return { status: "succeeded" };
        },
      });
    },
  };
  const push = (text: string) =>
    sink?.({
      surfaceId: "fake",
      contextId: "t1",
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
      messageId: "m1",
    });
  return { plugin, sent, push };
}

const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOTHING = '{"note":null,"shelf":null,"title":null,"forget":null,"terms":[],"people":[]}';
const REMEMBER =
  '{"note":null,"shelf":null,"title":null,"forget":null,"terms":[],"people":[' +
  '{"name":"丸山","note":"マーケ担当。Notion に詳しい","aliases":["丸山さん","マルさん"]}]}';

async function run(decision: string, text: string) {
  const m = scripted(decision);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push(text);
  await drain();
  return { agent, requests: m.requests, sent: s.sent, push: s.push };
}

test("人について分かったことを覚える", async () => {
  const { agent } = await run(REMEMBER, "丸山です。マーケ担当で、Notion をよく使います");

  const tools = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  expect(tools).toContain("person.remember");

  await agent.destroy();
});

test("覚えた人が次のターンで文脈に入る（呼び名でも引ける）", async () => {
  const { agent, requests, push } = await run(REMEMBER, "丸山です。マーケ担当です");

  push("マルさん、この件どう思います？");
  await drain();

  const conversation = requests.filter((r) => !r.system.includes("記憶係"));
  expect(conversation.at(-1)?.system).toContain("この会話に出てくる人");
  expect(conversation.at(-1)?.system).toContain("Notion に詳しい");

  await agent.destroy();
});

test("何を書かないかが判定の指示に入っている（ここが本体）", async () => {
  const { agent, requests } = await run(NOTHING, "やあ");
  const decision = requests.find((r) => r.system.includes("記憶係"))?.system ?? "";

  // 評価は書かない。**褒めるものも**書かない、まで言う
  expect(decision).toContain("評価・人物評は書かない");
  expect(decision).toContain("褒めるものも書かない");
  // 事実と評価の境界を例で示す
  expect(decision).toContain("「優秀」");
  // Slack を見れば分かることは覚えない（ADR 0001 と同じ判断）
  expect(decision).toContain("Slack を見れば分かることは書かない");
  // 推測を事実として書かない
  expect(decision).toContain("推測を事実として書かない");

  await agent.destroy();
});

test("名前か中身が欠けていたら載せない", async () => {
  for (const broken of [
    '{"people":[{"name":"丸山"}]}',
    '{"people":[{"note":"マーケ担当"}]}',
    '{"people":["文字列"]}',
  ]) {
    const { agent } = await run(broken, "なにか");
    const tools = agent.ctx.audit
      .recent()
      .filter((e) => e.action === "tool.invoked")
      .map((e) => e.payload.tool);
    expect(tools).not.toContain("person.remember");
    await agent.destroy();
  }
});

test("1ターンの上限は5人、同じ人は1回", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `人${i}`,
    note: "担当",
    aliases: [],
  }));
  const { agent } = await run(`{"people":${JSON.stringify(many)}}`, "紹介です");

  const defined = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked" && e.payload.tool === "person.remember");
  expect(defined).toHaveLength(5);

  await agent.destroy();
});

test("機微情報の印は人にも付く", async () => {
  const { agent } = await run(
    '{"people":[{"name":"佐藤","note":"来月から休職","aliases":[]}]}',
    "佐藤さんのこと",
  );

  const marked = agent.ctx.audit.recent().find((e) => e.action === "memory.sensitive_marked");
  expect(marked?.payload).toMatchObject({ tool: "person.remember", categories: ["health"] });

  await agent.destroy();
});
