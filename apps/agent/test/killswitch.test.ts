/**
 * キルスイッチのコア挙動（env 不要）。設計書 §12-4 / §12-7、運用は kill-switch.md。
 *
 * 検証すること:
 * 1. レベル1/2（`/russell stop`）は自発行動を凍結し、mention には停止中とだけ返す
 * 2. 凍結状態が読めないときは完全沈黙（fail-closed）
 * 3. ターンの途中で発動されたら送信しない（副作用の直前に再検査, §5.1）
 * 4. 凍結中の Policy Gate は状態を変える行為を `stopped` で止める
 * 5. レベル3（env）が最優先で、**DB を一切読まない**（DB 障害時にも効く）
 */

import { FROZEN_NOTICE, createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type {
  InboundMessage,
  KillSwitchCapability,
  RussellPlugin,
  StopState,
  Temperament,
} from "@edv4h/russell-shared";
import { KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

const RUNNING: StopState = { stopped: false, scope: null, by: null, at: null, reason: null };
const STOPPED: StopState = {
  stopped: true,
  scope: "agent",
  by: "u-ops",
  at: "2026-08-05T00:00:00.000Z",
  reason: "誤送信が続いた",
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

/**
 * 通常経路（DB）の代わり。`current` の呼ばれ方まで見たいので回数を数える。
 * 状態を関数で与えるのは「ターンの途中で発動される」を再現するため。
 */
function fakeKillSwitch(current: (call: number) => StopState | Promise<StopState>) {
  const state = { calls: 0 };
  const capability: KillSwitchCapability = {
    async current() {
      state.calls += 1;
      return await current(state.calls);
    },
    async stop() {
      throw new Error("未使用");
    },
    async resume() {
      throw new Error("未使用");
    },
  };
  const plugin: RussellPlugin = {
    id: "fake-killswitch",
    name: "fake kill switch",
    setup(ctx) {
      ctx.services.provide<KillSwitchCapability>(KILL_SWITCH_SERVICE, capability);
    },
  };
  return { plugin, state };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function plugins(...extra: RussellPlugin[]): RussellPlugin[] {
  return [createInMemoryMemoryPlugin(), createEchoModelPlugin(), ...extra];
}

const actionsOf = (agent: { ctx: { audit: { recent(): { action: string }[] } } }) =>
  agent.ctx.audit.recent().map((e) => e.action);

test("凍結中（レベル1/2）は mention に停止中とだけ返し、モデルもツールも動かさない", async () => {
  const s = captureSurface();
  const ks = fakeKillSwitch(() => STOPPED);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    plugins(ks.plugin, s.plugin),
  );

  s.push("これ覚えておいて");
  await drain();

  expect(s.sent).toEqual([FROZEN_NOTICE]);
  const actions = actionsOf(agent);
  expect(actions).toContain("turn.frozen");
  // 自発行動どころか、記憶書き込みもモデル呼び出しも起きていない
  expect(actions).not.toContain("tool.invoked");
  expect(actions).not.toContain("model.requested");
  await agent.destroy();
});

test("凍結状態が読めないときは完全沈黙（fail-closed, §12-7）", async () => {
  const s = captureSurface();
  const ks = fakeKillSwitch(() => {
    throw new Error("DB 障害");
  });
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    plugins(ks.plugin, s.plugin),
  );

  s.push("こんにちは");
  await drain();

  // 「止まっています」すら返さない。停止中か分からないまま投稿するのも外部送信なので黙る。
  expect(s.sent).toEqual([]);
  expect(actionsOf(agent)).not.toContain("turn.frozen");
  await agent.destroy();
});

test("ターンの途中で発動されたら応答を送らない（副作用の直前に再検査, §5.1）", async () => {
  const s = captureSurface();
  // 1回目（ターン開始時）は稼働中、2回目（送信直前）は凍結 = モデル呼び出し中に発動された状況
  const ks = fakeKillSwitch((call) => (call === 1 ? RUNNING : STOPPED));
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    plugins(ks.plugin, s.plugin),
  );

  s.push("こんにちは");
  await drain();

  expect(s.sent).toEqual([]);
  const actions = actionsOf(agent);
  expect(actions).toContain("model.requested"); // ターン自体は始まっていた
  expect(actions).toContain("surface.send.suppressed"); // が、送信の直前で止まった
  expect(actions).not.toContain("surface.send");
  await agent.destroy();
});

test("凍結中の Policy Gate は状態を変える行為を stopped で止める", async () => {
  const s = captureSurface();
  const ks = fakeKillSwitch((call) => (call === 1 ? RUNNING : STOPPED));
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    plugins(ks.plugin, s.plugin),
  );

  // ターン開始後に発動された状態で shelf.add（internal_write）へ入る
  s.push("これ覚えておいて");
  await drain();

  const denied = agent.ctx.audit.recent().find((e) => e.action === "policy.denied");
  expect(denied?.payload).toMatchObject({ tool: "shelf.add", reason: "stopped" });
  expect(s.sent).toEqual([]);
  await agent.destroy();
});

test("env RUSSELL_KILL=1 が最優先で、通常経路（DB）を読まない（§12-7 別経路）", async () => {
  process.env.RUSSELL_KILL = "1";
  try {
    const s = captureSurface();
    const ks = fakeKillSwitch(() => RUNNING); // DB 上は「稼働中」でも黙る
    const agent = await createAgent(
      { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
      plugins(ks.plugin, s.plugin),
    );

    s.push("こんにちは");
    await drain();

    expect(s.sent).toEqual([]);
    // DB を1度も見ていない = DB が落ちていても効く経路であることの実体
    expect(ks.state.calls).toBe(0);
    await agent.destroy();
  } finally {
    // biome-ignore lint/performance/noDelete: env のクリーンアップは delete が正しい（= undefined は文字列 "undefined" になる）。
    delete process.env.RUSSELL_KILL;
  }
});
