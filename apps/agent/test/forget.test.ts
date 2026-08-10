/**
 * 「忘れて」— L1（弱める）。env 不要。
 *
 * 設計（privacy-and-memory-policy §3）の3段階のうち、いま提供するのは L1 だけ。
 * L2（物理削除）以上は HITL 承認が前提で、既定値もサインオフ待ち。
 * **できていないことをできたと言わない**のが、この機能でいちばん大事なところ。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type { InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

function captureSurface() {
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
    });
  return { plugin, sent, push };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

async function bob(surface: RussellPlugin) {
  return createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [createInMemoryMemoryPlugin(), createEchoModelPlugin(), surface],
  );
}

test("「忘れて」で本棚から下げ、以降の想起に出てこない", async () => {
  const s = captureSurface();
  const agent = await bob(s.plugin);

  s.push("金曜の定例は15時、覚えておいて");
  await drain();
  s.push("さっきの話は？");
  await drain();
  expect(s.sent.at(-1)).toContain("覚えている内容"); // 想起されている

  s.push("金曜の定例のことは忘れて");
  await drain();
  expect(s.sent.at(-1)).toContain("書庫に下げました");

  // 書庫に落ちたので、以降の想起には出てこない
  const before = agent.ctx.audit.recent().length;
  s.push("さっきの話は？");
  await drain();
  expect(before).toBeGreaterThan(0);

  await agent.destroy();
});

test("消したとは言わない（実際にやったのは書庫落ち）", async () => {
  const s = captureSurface();
  const agent = await bob(s.plugin);

  s.push("この件は覚えておいて");
  await drain();
  s.push("この件は忘れて");
  await drain();

  const reply = s.sent.at(-1) ?? "";
  expect(reply).toContain("書庫に下げました");
  expect(reply).toContain("完全に消す場合"); // 何ができていないかを言う
  expect(reply).not.toContain("削除しました");

  await agent.destroy();
});

test("否定形を巻き込まない（「忘れてはいけない」で捨てない）", async () => {
  const s = captureSurface();
  const agent = await bob(s.plugin);

  s.push("金曜の定例、覚えておいて");
  await drain();

  for (const text of [
    "これは絶対に忘れてはいけない",
    "忘れないでね",
    "忘れずにお願いします",
    "忘れないようにしたい",
  ]) {
    s.push(text);
    await drain();
    expect(s.sent.at(-1)).not.toContain("書庫に下げました");
  }

  await agent.destroy();
});

test("該当が無ければ、無かったと言う", async () => {
  const s = captureSurface();
  const agent = await bob(s.plugin);

  s.push("存在しない話のことは忘れて");
  await drain();
  expect(s.sent.at(-1)).toContain("見つかりませんでした");

  await agent.destroy();
});

test("忘れる操作も Policy Gate と監査を通る", async () => {
  const s = captureSurface();
  const agent = await bob(s.plugin);

  s.push("これは忘れて");
  await drain();

  const invoked = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  expect(invoked).toContain("shelf.forget");
  // 来歴は untrusted のまま（他者の発言に起因する操作）
  const rec = agent.ctx.audit.recent().find((e) => e.payload.tool === "shelf.forget");
  expect(rec?.trustLabel).toBe("untrusted");

  await agent.destroy();
});
