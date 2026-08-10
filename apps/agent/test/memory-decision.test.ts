/**
 * 何を記憶するかをモデルが決める（P0-3/P0-4）。env 不要。
 *
 * 正規表現をやめた理由は3つ: 精度（「メモしなくていい」で書いてしまう）、
 * 言語（日本語以外は無反応）、明示依存（言われないと何も残らない）。
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

/**
 * 会話には固定文を返し、記憶の判定には決められた JSON を返すモデル。
 * 判定用プロンプトかどうかは system の内容で見分ける。
 */
function scriptedModel(decision: string) {
  const requests: ModelRequest[] = [];
  const plugin: RussellPlugin = {
    id: "scripted",
    name: "scripted model",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          requests.push(req);
          return { text: req.system.includes("記憶係") ? decision : "わかりました" };
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
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(decision: string, text: string) {
  const m = scriptedModel(decision);
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push(text);
  await drain();
  const tools = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  await agent.destroy();
  return { tools, sent: s.sent, reacted: s.reacted, requests: m.requests };
}

test("モデルが決めた内容を書き留める（明示的な依頼が無くても）", async () => {
  const { tools, reacted } = await run(
    '{"note":"金曜15時に定例","shelf":"チームの定例は金曜15時","forget":null}',
    "金曜の定例、15時からね",
  );

  expect(tools).toContain("note.write");
  expect(tools).toContain("shelf.add");
  expect(tools).not.toContain("shelf.forget");
  expect(reacted).toHaveLength(1); // 書き留めたことは 📝 で見せる
});

test("何も書かないと決めたら、何も起きない", async () => {
  const { tools, reacted, sent } = await run(
    '{"note":null,"shelf":null,"forget":null}',
    "ありがとう！",
  );

  expect(tools).toEqual([]);
  expect(reacted).toEqual([]);
  expect(sent).toHaveLength(1); // 返答はする
});

test("返答は判定より先に送る（レイテンシを返答の前に積まない）", async () => {
  const { requests, sent } = await run('{"note":"x","shelf":null,"forget":null}', "決まりました");

  // 会話用 → 記憶係の順。返答はすでに送られている
  expect(requests[0]?.system).not.toContain("記憶係");
  expect(requests[1]?.system).toContain("記憶係");
  expect(sent).toEqual(["わかりました"]);
});

test("判定が壊れていても会話は壊れない", async () => {
  for (const broken of ["これは JSON ではない", "", '{"note":', "{}"]) {
    const { tools, sent } = await run(broken, "こんにちは");
    expect(tools).toEqual([]);
    expect(sent).toHaveLength(1);
  }
});

test("判定は言語を問わない（プロンプトに日本語判定を埋め込まない）", async () => {
  const { tools } = await run(
    '{"note":"Meeting moved to 3pm Friday","shelf":null,"forget":null}',
    "The meeting moved to 3pm on Friday",
  );
  // 正規表現の頃は英語で何も起きなかった
  expect(tools).toContain("note.write");
});

test("忘れる判断も同じ経路を通る", async () => {
  const { tools } = await run('{"note":null,"shelf":null,"forget":"定例"}', "定例の件はもういいや");
  expect(tools).toContain("shelf.forget");
});

test("判定に渡すのは直前の1往復（履歴は渡さない）", async () => {
  const { requests } = await run('{"note":null,"shelf":null,"forget":null}', "やあ");
  const decision = requests.find((r) => r.system.includes("記憶係"));
  expect(decision?.user).toContain("相手: やあ");
  expect(decision?.user).toContain("同僚: わかりました");
  expect(decision?.history).toBeUndefined();
});
