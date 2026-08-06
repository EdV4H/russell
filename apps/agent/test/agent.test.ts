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
  ReactionRequest,
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

/** テスト用の通信面。push で mention を注入し、send / react をキャプチャする。 */
function captureSurface(options: { react?: boolean } = {}) {
  const sent: string[] = [];
  const reacted: ReactionRequest[] = [];
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
        // react は任意契約。false を渡すと「対応しない通信面」を再現する。
        ...(options.react === false
          ? {}
          : {
              async react(r: ReactionRequest) {
                reacted.push(r);
                return { status: "succeeded" as const };
              },
            }),
      });
    },
  };
  const push = (text: string, messageId?: string) =>
    sink?.({
      surfaceId: "fake",
      contextId: "t1",
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
      messageId,
    });
  return { plugin, sent, reacted, push };
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

test("メモを取ったら、その発言に「メモしました」を可視化する（§10.1）", async () => {
  const s = captureSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    offlinePlugins(s.plugin),
  );

  s.push("金曜の定例、覚えておいて", "m-1");
  await drain();

  // 発言単位（messageId）に付く。contextId はスレッド単位なので付け先にならない
  expect(s.reacted).toEqual([{ contextId: "t1", messageId: "m-1", kind: "noted" }]);
  // ワークスペースから見える行為なので監査にも残る
  expect(agent.ctx.audit.recent().map((e) => e.action)).toContain("surface.react");

  // メモを取らないターンでは増えない
  s.push("こんにちは", "m-2");
  await drain();
  expect(s.reacted.length).toBe(1);

  await agent.destroy();
});

test("react を実装しない通信面でも、メモ自体は成立する", async () => {
  const s = captureSurface({ react: false });
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    offlinePlugins(s.plugin),
  );

  s.push("これ覚えておいて", "m-1");
  await drain();

  expect(s.sent.some((t) => t.includes("覚えておきます"))).toBe(true);
  expect(agent.ctx.audit.recent().map((e) => e.action)).toContain("tool.invoked");
  expect(agent.ctx.audit.recent().map((e) => e.action)).not.toContain("surface.react");

  await agent.destroy();
});

test("destroy() は実行中のターンを待ってから片付ける", async () => {
  const s = captureSurface();
  // モデル応答に時間がかかる状況を作る（実際は DB 往復や API 呼び出しがここに入る）
  const slowModel: RussellPlugin = {
    id: "slow-model",
    name: "slow model",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete() {
          await new Promise((r) => setTimeout(r, 50));
          return { text: "遅れて返事" };
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [createInMemoryMemoryPlugin(), slowModel, s.plugin],
  );

  s.push("こんにちは");
  await agent.destroy(); // drain しないと surface を先に外してしまい、応答が消える

  expect(s.sent).toEqual(["遅れて返事"]);
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
