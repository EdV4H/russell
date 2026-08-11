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
import { scriptedModel } from "./memory-model.js";

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

test("モデルが本棚に入れると決めたら、次のターンの想起に反映される", async () => {
  const s = captureSurface();
  const m = scriptedModel('{"note":null,"shelf":"金曜の定例は15時","forget":null}');
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  s.push("金曜の定例、15時からね");
  await drain();

  // 次のターンでは、本棚の中身が人格プロンプトに載って渡る
  s.push("それ何だっけ？");
  await drain();
  expect(m.conversations.at(-1)?.system).toContain("金曜の定例は15時");

  await agent.destroy();
});

test("mention に応答する（P0-1/P0-2 相当）", async () => {
  const s = captureSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
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
      { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
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
  const m = scriptedModel('{"note":"金曜15時に定例","shelf":null,"forget":null}');
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  s.push("金曜の定例、15時からね", "m-1");
  await drain();

  // 発言単位（messageId）に付く。contextId はスレッド単位なので付け先にならない
  expect(s.reacted).toEqual([{ contextId: "t1", messageId: "m-1", kind: "noted" }]);
  // ワークスペースから見える行為なので監査にも残る
  expect(agent.ctx.audit.recent().map((e) => e.action)).toContain("surface.react");

  await agent.destroy();
});

test("何も書き留めないターンにはリアクションを付けない", async () => {
  const s = captureSurface();
  const m = scriptedModel(); // 既定＝何も書かない
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  s.push("ありがとう", "m-1");
  await drain();
  expect(s.reacted).toEqual([]);

  await agent.destroy();
});

test("react を実装しない通信面でも、メモ自体は成立する", async () => {
  const s = captureSurface({ react: false });
  const m = scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}');
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );

  s.push("これ大事なんだ", "m-1");
  await drain();

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
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
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

test("ターンが落ちたら黙らずに伝える（#25）", async () => {
  const s = captureSurface();
  const broken: RussellPlugin = {
    id: "broken-model",
    name: "落ちるモデル",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete() {
          // 隔離チェックの中止と同じ形。ターンの途中で throw する
          throw new Error("model-claude-code: 隔離が破れています");
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [createInMemoryMemoryPlugin(), broken, s.plugin],
  );

  s.push("Notionで定例のページを見てもらえる？");
  await drain();

  // 既読無視にしない
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]).toContain("うまく応答できませんでした");
  // 落ちた理由そのものは相手に言わない（内部構造を晒さない）
  expect(s.sent[0]).not.toContain("隔離");
  const failed = agent.ctx.audit.recent().find((e) => e.action === "turn.failed");
  expect(failed?.payload.error).toContain("隔離が破れています"); // 監査には残る

  await agent.destroy();
});

test("凍結中はターンが落ちても沈黙する", async () => {
  const s = captureSurface();
  const broken: RussellPlugin = {
    id: "broken-model-2",
    name: "落ちるモデル",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete() {
          throw new Error("boom");
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [createInMemoryMemoryPlugin(), broken, s.plugin],
  );
  process.env.RUSSELL_KILL = "1";
  try {
    s.push("こんにちは");
    await drain();
    expect(s.sent).toEqual([]);
  } finally {
    process.env.RUSSELL_KILL = "0";
  }
  await agent.destroy();
});
