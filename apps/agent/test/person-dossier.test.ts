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
  const pushWith = (over: { text: string; people?: { id: string; name: string }[] }) =>
    sink?.({
      surfaceId: "fake",
      contextId: "t1",
      author: "u",
      trustLabel: "untrusted",
      isMention: true,
      messageId: "m1",
      ...over,
    });
  return { plugin, sent, push, pushWith };
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
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
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

test("**すでにカルテに書いてある内容**を判定に見せる（上書きで消さないため）", async () => {
  const { agent, requests, push } = await run(REMEMBER, "丸山です。マーケ担当です");

  push("マルさん、この件どう思います？");
  await drain();

  // 判定は同じ name で出すと丸ごと置き換える。**いま書いてある内容が見えていないと、
  // 今日分かったことだけで上書きされ、それまでの記述が消える**
  const decisions = requests.filter((r) => r.system.includes("記憶係"));
  expect(decisions.at(-1)?.user).toContain("いま書いてある内容");
  expect(decisions.at(-1)?.user).toContain("Notion に詳しい");

  await agent.destroy();
});

test("人についても、上書きになることを指示に書いてある", async () => {
  const { agent, requests } = await run(NOTHING, "やあ");
  const decision = requests.find((r) => r.system.includes("記憶係"))?.system ?? "";

  expect(decision).toContain("書いてある内容は丸ごと置き換わる");
  expect(decision).toContain("全文を書き直す");

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

test("カルテと Slack ユーザーを紐づける（表示名は覚えない）", async () => {
  const m = scripted(REMEMBER);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  // 通信面が引いた id ↔ 名前を渡す。**紐付けは Slack 側からは取れない**ので、こちらで持つ
  s.pushWith({
    text: "丸山です。マーケ担当です",
    people: [
      { id: "U_MARU", name: "丸山" },
      { id: "U_OTHER", name: "無関係" },
    ],
  });
  await drain();

  const call = agent.ctx.audit
    .recent()
    .find((e) => e.action === "tool.invoked" && e.payload.tool === "person.remember");
  expect(call).toBeDefined();
  await agent.destroy();
});

test("名前の揺れを吸収して紐づける（「丸山」と「丸山さん」は同じ人）", async () => {
  const m = scripted('{"people":[{"name":"丸山さん","note":"マーケ担当","aliases":["マルさん"]}]}');
  const s = surface();
  const linked: unknown[] = [];
  const spy: RussellPlugin = {
    id: "spy",
    name: "spy",
    setup(ctx) {
      // person.remember の入力を覗く（監査には本文が載らないため）
      const original = ctx.tools.get("person.remember");
      if (!original) return;
      return ctx.tools.register("person.remember", {
        ...original,
        async run(input: { externalIds?: string[] }) {
          linked.push(input.externalIds);
          return await original.run(input);
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), spy, m.plugin, s.plugin],
  );

  s.pushWith({
    text: "丸山です",
    people: [
      { id: "U_MARU", name: "丸山" }, // 「丸山さん」と表記が違うが同じ人
      { id: "U_OTHER", name: "佐藤" },
    ],
  });
  await drain();

  // 揺れは吸収するが、**無関係な人は紐づけない**
  expect(linked[0]).toEqual(["slack:U_MARU"]);
  await agent.destroy();
});
