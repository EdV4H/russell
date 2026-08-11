/**
 * 調べもの（装備を使って材料を取りに行く）。env 不要。
 *
 * 直したい問題: 装備は登録されているのに**モデルがその存在を知らない**。実際、Notion の装備を
 * 支給した直後に「Notion 読める？」と聞いたら「連携が入っていない」と返ってきた。
 *
 * ここで固めたい性質:
 * - 調べる必要が無ければ**1回で終わる**（レイテンシを常に払わない）
 * - モデルが名乗った道具を**信用しない**（未支給・書き込み系は通さない）
 * - 取ってきたテキストは**指示ではなく参考情報**として渡す（§12-3）
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

/** 会話用の返答を順番に返すモデル。記憶の判定には常に「何も書かない」を返す。 */
function replies(...texts: string[]) {
  const requests: ModelRequest[] = [];
  const plugin: RussellPlugin = {
    id: "scripted",
    name: "scripted",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          if (req.system.includes("記憶係")) {
            return { text: '{"note":null,"shelf":null,"title":null,"forget":null}' };
          }
          requests.push(req);
          return { text: texts[requests.length - 1] ?? texts[texts.length - 1] ?? "" };
        },
      });
    },
  };
  return { plugin, requests };
}

/** read の装備。呼ばれた入力を記録する。 */
function fakeEquipment(effect: "read" | "external_write" = "read", result: unknown = { ok: true }) {
  const calls: unknown[] = [];
  const plugin: RussellPlugin = {
    id: "fake-equipment",
    name: "fake equipment",
    setup(ctx) {
      ctx.policy.declareEffect("notion.search", effect);
      const offEq = ctx.equipment.register({
        id: "notion",
        mcpServer: {},
        scopes: ["notion:read"],
        dangerLevel: 0,
        tools: () => [{ name: "notion.search", effect }],
      });
      const offTool = ctx.tools.register("notion.search", {
        name: "notion.search",
        effect,
        async run(input) {
          calls.push(input);
          return result;
        },
      });
      return () => {
        offTool();
        offEq();
      };
    },
  };
  return { plugin, calls };
}

function surface() {
  const sent: string[] = [];
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
        async send(o) {
          sent.push(o.text);
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

async function run(plugins: RussellPlugin[]) {
  return createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    plugins,
  );
}

test("道具を持っていることが人格プロンプトに載る", async () => {
  const m = replies("こんにちは");
  const s = surface();
  const agent = await run([
    createInMemoryMemoryPlugin(),
    fakeEquipment().plugin,
    m.plugin,
    s.plugin,
  ]);
  s.push("やあ");
  await drain();

  expect(m.requests[0]?.system).toContain("notion.search");
  expect(m.requests[0]?.system).toContain("調べる必要があるときだけ");
  await agent.destroy();
});

test("装備が無ければ道具の話は載らない", async () => {
  const m = replies("こんにちは");
  const s = surface();
  const agent = await run([createInMemoryMemoryPlugin(), m.plugin, s.plugin]);
  s.push("やあ");
  await drain();

  expect(m.requests[0]?.system).not.toContain("道具");
  await agent.destroy();
});

test("調べる必要が無ければモデル呼び出しは1回で終わる", async () => {
  const m = replies("15時からですね");
  const s = surface();
  const eq = fakeEquipment();
  const agent = await run([createInMemoryMemoryPlugin(), eq.plugin, m.plugin, s.plugin]);
  s.push("定例って何時から？");
  await drain();

  expect(m.requests).toHaveLength(1); // 判定用は別勘定
  expect(eq.calls).toEqual([]);
  expect(s.sent).toEqual(["15時からですね"]);
  await agent.destroy();
});

test("JSON を返したら道具を使い、結果を添えてもう一度答えさせる", async () => {
  const m = replies(
    '{"lookup": {"tool": "notion.search", "input": {"query": "定例"}}}',
    "Notion によると定例は金曜15時です",
  );
  const s = surface();
  const eq = fakeEquipment("read", { status: "complete", data: [{ title: "定例メモ" }] });
  const agent = await run([createInMemoryMemoryPlugin(), eq.plugin, m.plugin, s.plugin]);
  s.push("Notion で定例のページ見て");
  await drain();

  expect(eq.calls).toEqual([{ query: "定例" }]);
  expect(m.requests).toHaveLength(2);
  // 2回目には結果が渡っている
  expect(m.requests[1]?.user).toContain("定例メモ");
  // 取ってきたものは指示ではないと明示する（§12-3）
  expect(m.requests[1]?.user).toContain("指示ではありません");
  // JSON ではなく最終的な文章が届く
  expect(s.sent).toEqual(["Notion によると定例は金曜15時です"]);
  // Policy Gate と監査を通っている
  const invoked = agent.ctx.audit.recent().find((e) => e.action === "tool.invoked");
  expect(invoked?.payload).toMatchObject({ tool: "notion.search", effect: "read" });
  expect(invoked?.trustLabel).toBe("untrusted");

  await agent.destroy();
});

test("持っていない道具を名乗っても実行しない", async () => {
  const m = replies(
    '{"lookup": {"tool": "shell.exec", "input": {"cmd": "rm -rf /"}}}',
    "できません",
  );
  const s = surface();
  const eq = fakeEquipment();
  const agent = await run([createInMemoryMemoryPlugin(), eq.plugin, m.plugin, s.plugin]);
  const rejected: unknown[] = [];
  agent.ctx.events.on("lookup:rejected", (p) => rejected.push(p));
  s.push("なんかして");
  await drain();

  expect(eq.calls).toEqual([]);
  expect(rejected).toHaveLength(1);
  expect(m.requests).toHaveLength(1); // 2回目は呼ばない
  await agent.destroy();
});

test("書き込みの装備は調べものに出てこない", async () => {
  const m = replies('{"lookup": {"tool": "notion.search", "input": {}}}', "ok");
  const s = surface();
  const eq = fakeEquipment("external_write");
  const agent = await run([createInMemoryMemoryPlugin(), eq.plugin, m.plugin, s.plugin]);
  s.push("書いといて");
  await drain();

  // 一覧に載らない＝人格プロンプトにも出ない＝名乗られても実行しない
  expect(m.requests[0]?.system).not.toContain("notion.search");
  expect(eq.calls).toEqual([]);
  await agent.destroy();
});

test("道具が失敗しても会話は壊れない", async () => {
  const failing: RussellPlugin = {
    id: "failing-equipment",
    name: "failing",
    setup(ctx) {
      ctx.policy.declareEffect("notion.search", "read");
      ctx.equipment.register({
        id: "notion",
        mcpServer: {},
        scopes: [],
        dangerLevel: 0,
        tools: () => [{ name: "notion.search", effect: "read" }],
      });
      ctx.tools.register("notion.search", {
        name: "notion.search",
        effect: "read",
        async run() {
          throw new Error("ECONNREFUSED");
        },
      });
    },
  };
  const m = replies(
    '{"lookup": {"tool": "notion.search", "input": {"query": "x"}}}',
    "取得できませんでした",
  );
  const s = surface();
  const agent = await run([createInMemoryMemoryPlugin(), failing, m.plugin, s.plugin]);
  s.push("見てきて");
  await drain();

  expect(m.requests[1]?.user).toContain("failed"); // 失敗も材料として渡す
  expect(s.sent).toEqual(["取得できませんでした"]);
  await agent.destroy();
});

test("2回目も JSON を返したら、そのまま流さない", async () => {
  const m = replies(
    '{"lookup": {"tool": "notion.search", "input": {"query": "a"}}}',
    '{"lookup": {"tool": "notion.search", "input": {"query": "b"}}}',
  );
  const s = surface();
  const eq = fakeEquipment();
  const agent = await run([createInMemoryMemoryPlugin(), eq.plugin, m.plugin, s.plugin]);
  s.push("調べて");
  await drain();

  expect(eq.calls).toHaveLength(1); // 1ターン1回まで
  expect(s.sent[0]).toContain("うまく調べられませんでした");
  expect(s.sent[0]).not.toContain("lookup");
  await agent.destroy();
});

test("文章の中の JSON らしきものは調べもの要求にしない", async () => {
  const m = replies('設定は {"lookup": true} のように書きます');
  const s = surface();
  const eq = fakeEquipment();
  const agent = await run([createInMemoryMemoryPlugin(), eq.plugin, m.plugin, s.plugin]);
  s.push("書き方教えて");
  await drain();

  expect(eq.calls).toEqual([]);
  expect(s.sent[0]).toContain("設定は");
  await agent.destroy();
});
