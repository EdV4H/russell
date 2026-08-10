/**
 * 会話の短期記憶（env 不要）。
 *
 * スレッドで「で、どうする？」と言われて話が通じるのは、直前の数往復を覚えているから。
 * メモ帳・本棚（長期記憶）とは別物で、両方ないと会話にならない。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { toMessages } from "@edv4h/russell-plugin-model-claude";
import { renderPrompt } from "@edv4h/russell-plugin-model-claude-code";
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

/** モデルに何が渡ったかを記録するプロバイダ。 */
function recordingModel() {
  const requests: ModelRequest[] = [];
  const plugin: RussellPlugin = {
    id: "recording-model",
    name: "recording model",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          requests.push(req);
          return { text: `返事${requests.length}` };
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
  const push = (text: string, contextId = "t1") =>
    sink?.({
      surfaceId: "fake",
      contextId,
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, push };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

test("2ターン目には直前のやりとりが渡る", async () => {
  const m = recordingModel();
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  s.push("金曜の定例、どう思う？");
  await drain();
  expect(m.requests[0]?.history ?? []).toEqual([]); // 1発目は履歴なし

  s.push("で、どうする？");
  await drain();
  // 「で、どうする？」だけでは何の話か分からない。直前の往復が付いて初めて通じる
  expect(m.requests[1]?.history).toEqual([
    { role: "user", text: "金曜の定例、どう思う？" },
    { role: "assistant", text: "返事1" },
  ]);
  expect(m.requests[1]?.user).toBe("で、どうする？");

  await agent.destroy();
});

test("文脈が違えば混ざらない（別スレッドの話は持ち込まない）", async () => {
  const m = recordingModel();
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  s.push("スレッドAの話", "thread-a");
  await drain();
  s.push("スレッドBの話", "thread-b");
  await drain();

  expect(m.requests[1]?.history).toEqual([]); // B に A の話は混ざらない

  s.push("Aの続き", "thread-a");
  await drain();
  expect(m.requests[2]?.history?.map((t) => t.text)).toEqual(["スレッドAの話", "返事1"]);

  await agent.destroy();
});

test("古いやりとりは捨てる（無制限に伸びない）", async () => {
  const m = recordingModel();
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  for (let i = 1; i <= 15; i++) {
    s.push(`発言${i}`);
    await drain();
  }
  const last = m.requests.at(-1)?.history ?? [];
  expect(last.length).toBeLessThanOrEqual(20);
  // 直近が残り、古いものから落ちる
  expect(last.at(-2)?.text).toBe("発言14");
  expect(last.some((t) => t.text === "発言1")).toBe(false);

  await agent.destroy();
});

test("Claude API へは messages 配列として渡す（先頭が assistant なら落とす）", () => {
  expect(
    toMessages({
      system: "",
      user: "いま",
      history: [
        { role: "user", text: "前" },
        { role: "assistant", text: "返事" },
      ],
    }),
  ).toEqual([
    { role: "user", content: "前" },
    { role: "assistant", content: "返事" },
    { role: "user", content: "いま" },
  ]);

  // 切り詰めで先頭が assistant になった配列は API が受け取らないので落とす
  expect(
    toMessages({ system: "", user: "いま", history: [{ role: "assistant", text: "途中から" }] }),
  ).toEqual([{ role: "user", content: "いま" }]);
});

test("Claude Code（1発の CLI）へは書き起こしとして渡す", () => {
  expect(renderPrompt({ user: "で、どうする？" })).toBe("で、どうする？"); // 履歴が無ければそのまま

  const rendered = renderPrompt({
    user: "で、どうする？",
    history: [
      { role: "user", text: "金曜の定例" },
      { role: "assistant", text: "把握しています" },
    ],
  });
  expect(rendered).toContain("相手: 金曜の定例");
  expect(rendered).toContain("あなた: 把握しています");
  expect(rendered.endsWith("相手: で、どうする？")).toBe(true); // 答えるべきは最後の1行
});
