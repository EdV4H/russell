/**
 * オフライン stack に対する P0 の統合テスト（env 不要）。
 * 認知ループ・記憶ツール（shelf.add）・想起・Policy Gate（killswitch 凍結）を検証する。
 * ビルド済みパッケージ（dist）に対して vitest で実行する。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type {
  InboundMessage,
  ModelProvider,
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

/** テスト用の通信面。push で mention を注入し、send をキャプチャする。 */
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
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function offlinePlugins(surface: RussellPlugin): RussellPlugin[] {
  return [createInMemoryMemoryPlugin(), createEchoModelPlugin(), surface];
}

test("「覚えておいて」で shelf.add が発火し、次のターンの想起に反映される", async () => {
  const s = captureSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    offlinePlugins(s.plugin),
  );

  s.push("金曜の定例、覚えておいて");
  await drain();
  expect(s.sent.some((t) => t.includes("覚えておきます"))).toBe(true);

  s.push("それ何だっけ？");
  await drain();
  // 本棚に入った内容が recall され、モデルが記憶を踏まえた旨を返す
  expect(s.sent.at(-1)).toContain("覚えている内容");

  await agent.destroy();
});

test("mention に応答する（P0-1/P0-2 相当）", async () => {
  const s = captureSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    offlinePlugins(s.plugin),
  );
  s.push("こんにちは");
  await drain();
  expect(s.sent.length).toBe(1);
  await agent.destroy();
});

test("キルスイッチ（RUSSELL_KILL=1）で自発/応答が凍結する（§12-4/§12-7）", async () => {
  process.env.RUSSELL_KILL = "1";
  try {
    const s = captureSurface();
    const agent = await createAgent(
      { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
      offlinePlugins(s.plugin),
    );
    s.push("覚えておいて: これは凍結中");
    await drain();
    expect(s.sent.length).toBe(0); // 応答も shelf.add も起きない
    await agent.destroy();
  } finally {
    // biome-ignore lint/performance/noDelete: env のクリーンアップは delete が正しい（= undefined は文字列 "undefined" になる）。
    delete process.env.RUSSELL_KILL;
  }
});

test("echo モデルは決定論的（質問と平叙で応答が変わる）", async () => {
  let provider: ModelProvider | undefined;
  const fakeCtx = {
    models: {
      register(m: ModelProvider) {
        provider = m;
        return () => {};
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: setup が触るのは models のみのテスト用スタブ。
  } as any;
  createEchoModelPlugin().setup(fakeCtx);

  const q = await provider?.complete({ system: "", user: "これは質問？" });
  const a = await provider?.complete({ system: "", user: "これは平叙。" });
  expect(q?.text).toContain("確認して");
  expect(a?.text).toContain("了解");
});
