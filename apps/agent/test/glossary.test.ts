/**
 * 単語帳（索引カード, ADR 0008）。env 不要。
 *
 * ユビキタス言語の表。**チームでだけ通じる言葉**を覚えて、次に出てきたときに
 * 知っている前提で話す。本棚と分けたのは、忘却の意味と引き方が違うため:
 * - 使わなくても忘れない（本棚は減衰して書庫へ落ちる）
 * - **その語が出た文**で引く（本棚は直近5冊）
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { MAX_INJECTED_TERMS, matchTerms } from "@edv4h/russell-plugin-memory-pg";
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

// --- 照合（純関数） ---

const TERMS = [
  { name: "MQL", summary: "マーケが獲得した見込み顧客", aliases: ["エムキューエル"] },
  { name: "MQL目標", summary: "四半期ごとに置く MQL の目標値", aliases: [] },
  { name: "チームづくり博", summary: "毎年開催している自社イベント", aliases: ["チー博"] },
];

test("文に出てきた語を引く", () => {
  expect(matchTerms("今月の MQL どうなってる？", TERMS).map((t) => t.name)).toEqual(["MQL"]);
});

test("別名でも引ける", () => {
  expect(matchTerms("チー博の準備しないと", TERMS).map((t) => t.name)).toEqual(["チームづくり博"]);
});

test("長い一致を優先する", () => {
  // 「MQL目標」は「MQL」も含むが、より具体的な方を先に出す
  expect(matchTerms("MQL目標の話", TERMS)[0]?.name).toBe("MQL目標");
});

test("大文字小文字を区別しない", () => {
  expect(matchTerms("今月の mql は？", TERMS).map((t) => t.name)).toContain("MQL");
});

test("1文字の別名は照合に使わない（誤爆する方が悪い）", () => {
  const risky = [{ name: "Aプロジェクト", summary: "…", aliases: ["A"] }];
  expect(matchTerms("Bのタスクを進めた", risky)).toEqual([]);
});

test("出てこなければ何も返さない", () => {
  expect(matchTerms("おはようございます", TERMS)).toEqual([]);
});

test("注入する件数に上限がある（文脈予算を単語帳で埋めない）", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    name: `用語${i}`,
    summary: "…",
    aliases: [],
  }));
  const text = many.map((t) => t.name).join(" ");
  expect(matchTerms(text, many)).toHaveLength(MAX_INJECTED_TERMS);
});

// --- 認知ループ ---

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
  const reacted: unknown[] = [];
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
        async react(r) {
          reacted.push(r);
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
  return { plugin, sent, reacted, push };
}

const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOTHING = '{"note":null,"shelf":null,"title":null,"forget":null,"term":null}';
const DEFINE_MQL =
  '{"note":null,"shelf":null,"title":null,"forget":null,' +
  '"term":{"name":"MQL","definition":"マーケが獲得した見込み顧客","aliases":["エムキューエル"]}}';

test("意味が説明されたら単語帳に載る", async () => {
  const m = scripted(DEFINE_MQL);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push("MQL っていうのはマーケが獲得した見込み顧客のことね");
  await drain();

  const tools = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  expect(tools).toContain("term.define");
  expect(s.reacted).toHaveLength(1); // 覚えたことは見せる（§10.1）

  await agent.destroy();
});

test("覚えた語が次のターンで文脈に入る", async () => {
  const m = scripted(DEFINE_MQL);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push("MQL っていうのはマーケが獲得した見込み顧客のことね");
  await drain();

  // 2ターン目。**別名**で言及しても引ける
  s.push("エムキューエル、今月どう？");
  await drain();

  const conversation = m.requests.filter((r) => !r.system.includes("記憶係"));
  expect(conversation.at(-1)?.system).toContain("この会話に出てくる言葉");
  expect(conversation.at(-1)?.system).toContain("マーケが獲得した見込み顧客");

  await agent.destroy();
});

test("関係ない会話には注入しない", async () => {
  const m = scripted(NOTHING);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push("おはようございます");
  await drain();

  const conversation = m.requests.filter((r) => !r.system.includes("記憶係"));
  expect(conversation[0]?.system).not.toContain("この会話に出てくる言葉");

  await agent.destroy();
});

test("名前か意味が欠けていたら載せない", async () => {
  for (const broken of [
    '{"term":{"name":"MQL"}}',
    '{"term":{"definition":"意味だけ"}}',
    '{"term":"文字列"}',
  ]) {
    const m = scripted(broken);
    const s = surface();
    const agent = await createAgent(
      { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
      [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
    );
    s.push("なにか");
    await drain();

    const tools = agent.ctx.audit
      .recent()
      .filter((e) => e.action === "tool.invoked")
      .map((e) => e.payload.tool);
    expect(tools).not.toContain("term.define");
    await agent.destroy();
  }
});

test("判定の指示は「一般語は載せない」と言っている", async () => {
  const m = scripted(NOTHING);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push("やあ");
  await drain();

  const decision = m.requests.find((r) => r.system.includes("記憶係"));
  expect(decision?.system).toContain("このチームでだけ通じる言葉");
  expect(decision?.system).toContain("辞書を引けば分かる一般語は載せない");

  await agent.destroy();
});
