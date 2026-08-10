/**
 * 監査ログ（event_log）の横断必須ゲート検証（test-strategy §5・設計書 §3.1/§12）。
 * env 不要（オフライン stack + テスト用 sink）。
 *
 * 検証すること:
 * 1. 全アクションが trust_label 付きで残る（受信→ツール→モデル→送信）
 * 2. 来歴の保存: untrusted な発言に起因するツール実行は untrusted のまま残る（§12-3）
 * 3. Policy Gate の拒否も残る（policy.denied + 理由コード）
 * 4. fail-closed: sink が全滅したら副作用（internal_write / 送信）を止める（§12-7）
 * 5. 監査に本文を入れない（機微情報を監査へ流さない, A1-5）
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type { AuditEvent, InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
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
      author: "u-slack-123",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, sent, push };
}

/**
 * 監査 sink のテストダブル。
 * - `failing=true` で全 write を失敗させる（DB 障害の模擬）
 * - `failFromAction` を指定すると、その action の記録から失敗し始める
 *   （「記録が失敗したその瞬間」に副作用が漏れないかを見るため）
 */
function captureAuditSink(opts: { failing?: boolean; failFromAction?: string } = {}) {
  const written: AuditEvent[] = [];
  let failing = opts.failing ?? false;
  const plugin: RussellPlugin = {
    id: "fake-audit",
    name: "fake audit sink",
    setup(ctx) {
      return ctx.audit.registerSink({
        id: "fake-audit",
        async write(event) {
          if (opts.failFromAction && event.action === opts.failFromAction) failing = true;
          if (failing) throw new Error("sink down");
          written.push(event);
        },
      });
    },
  };
  function setFailing(v: boolean): void {
    failing = v;
  }
  return { plugin, written, setFailing };
}

/** 呼び出し回数を数えるモデル provider。モデル呼び出しは課金される外部 I/O。 */
function countingModelPlugin() {
  const calls: unknown[] = [];
  const plugin: RussellPlugin = {
    id: "counting-model",
    name: "counting model",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          calls.push(req);
          return { text: "はい" };
        },
      });
    },
  };
  return { plugin, calls };
}

/** 実行回数を数える shelf.add。効果分類は申告する（= Policy Gate は本来通る）。 */
function countingShelfPlugin() {
  const runs: unknown[] = [];
  const plugin: RussellPlugin = {
    id: "counting-shelf",
    name: "counting shelf.add",
    setup(ctx) {
      ctx.policy.declareEffect("shelf.add", "internal_write");
      return ctx.tools.register("shelf.add", {
        name: "shelf.add",
        effect: "internal_write",
        async run(input: unknown) {
          runs.push(input);
          return { status: "succeeded" as const };
        },
      });
    },
  };
  return { plugin, runs };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

test("全アクションが trust_label 付きで event_log に残る（横断ゲート）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  s.push("金曜の定例、覚えておいて");
  await drain();

  const actions = a.written.map((e) => e.action);
  expect(actions).toContain("agent.started");
  expect(actions).toContain("turn.received");
  expect(actions).toContain("tool.invoked");
  expect(actions).toContain("model.completed");
  expect(actions).toContain("surface.send");

  // 全件に trust_label / agent_id / config_version が付く
  for (const e of a.written) {
    expect(e.trustLabel === "trusted" || e.trustLabel === "untrusted").toBe(true);
    expect(e.agentId).toBe("bob");
    expect(e.configVersion).toBe("v0");
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
  }

  await agent.destroy();
  expect(a.written.map((e) => e.action)).toContain("agent.stopped");
});

test("untrusted 発言に起因するツール実行は untrusted のまま残る（§12-3 来歴の保存）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  s.push("金曜の定例、覚えておいて");
  await drain();

  const received = a.written.find((e) => e.action === "turn.received");
  expect(received?.trustLabel).toBe("untrusted");
  expect(received?.actor).toBe("u-slack-123"); // 誰の発言かが残る

  const tool = a.written.find((e) => e.action === "tool.invoked");
  expect(tool?.payload.tool).toBe("shelf.add");
  expect(tool?.trustLabel).toBe("untrusted"); // 来歴を失わせない

  // 送信は個体自身の行為なので trusted
  expect(a.written.find((e) => e.action === "surface.send")?.trustLabel).toBe("trusted");

  await agent.destroy();
});

test("監査に本文を入れない（機微情報を監査へ流さない, A1-5）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  s.push("山田さんの給与は機密、覚えておいて");
  await drain();

  const serialized = JSON.stringify(a.written);
  expect(serialized).not.toContain("給与");
  // 代わりに長さだけ残る
  expect(a.written.find((e) => e.action === "turn.received")?.payload.textLength).toBe(17);

  await agent.destroy();
});

test("Policy Gate の拒否も理由コード付きで残る（default-deny）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  // 効果分類を申告しないツールを登録するプラグイン（= 未申告 default deny）
  const rogue: RussellPlugin = {
    id: "rogue",
    name: "rogue tool",
    setup(ctx) {
      return ctx.tools.register("shelf.add", {
        name: "shelf.add",
        effect: "internal_write",
        async run() {
          return { status: "succeeded" as const };
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    // memory プラグインを外す = declareEffect が走らないので shelf.add は未申告
    [
      a.plugin,
      rogue,
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  s.push("これ覚えておいて");
  await drain();

  const denied = a.written.find((e) => e.action === "policy.denied");
  expect(denied?.payload.tool).toBe("shelf.add");
  expect(denied?.payload.reason).toBe("effect_undeclared");
  expect(denied?.trustLabel).toBe("untrusted");

  await agent.destroy();
});

test("fail-closed: 監査 sink が全滅したら書き込みも送信も止まる（§12-7）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  const degraded: string[] = [];
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );
  agent.ctx.events.on("audit:degraded", () => degraded.push("degraded"));

  // 正常時は応答が返る
  s.push("こんにちは");
  await drain();
  expect(s.sent.length).toBe(1);

  // sink 障害を注入
  a.setFailing(true);
  s.push("これ覚えておいて");
  await drain();

  expect(degraded.length).toBeGreaterThan(0);
  expect(agent.ctx.audit.healthy()).toBe(false);
  expect(s.sent.length).toBe(1); // 応答は増えない = 送信が止まっている

  // 復旧すれば再開する
  a.setFailing(false);
  s.push("もう一度こんにちは");
  await drain();
  expect(agent.ctx.audit.healthy()).toBe(true);
  expect(s.sent.length).toBe(2);

  await agent.destroy();
});

test("tool.invoked の記録が最初の失敗になってもツールは実行されない（fail-closed の窓）", async () => {
  const s = captureSurface();
  const a = captureAuditSink({ failFromAction: "tool.invoked" });
  const shelf = countingShelfPlugin();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      shelf.plugin,
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  // Policy Gate の事前判定は通る（効果分類は申告済み・その時点では healthy）。
  // 落ちるのは tool.invoked の記録そのもの。
  s.push("金曜の定例は15時");
  await drain();

  expect(shelf.runs.length).toBe(0); // 監査が残らなかったので実行しない
  expect(agent.ctx.audit.healthy()).toBe(false);
  // 記憶の書き込みは返答の後に走るので、返答自体はすでに出ている（その記録は成功していた）。
  // ここで守りたいのは「記録が残らなければ副作用を起こさない」であって、返答の抑止ではない。
  expect(s.sent.length).toBe(1);

  await agent.destroy();
});

test("surface.send の記録が最初の失敗になっても送信しない（fail-closed の窓）", async () => {
  const s = captureSurface();
  const a = captureAuditSink({ failFromAction: "surface.send" });
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  // 受信・モデル呼び出しまでは監査が残る。落ちるのは送信直前の記録。
  s.push("こんにちは");
  await drain();

  expect(a.written.map((e) => e.action)).toContain("model.completed");
  expect(s.sent.length).toBe(0); // 監査が残らなかったので送らない
  expect(agent.ctx.audit.healthy()).toBe(false);

  await agent.destroy();
});

test("turn.received の記録が失敗したらモデルを呼ばずにターンごと中止する", async () => {
  const s = captureSurface();
  const a = captureAuditSink({ failFromAction: "turn.received" });
  const model = countingModelPlugin();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [a.plugin, createInMemoryMemoryPlugin(), model.plugin, s.plugin],
  );

  // 記憶コマンドを含まない普通の発話。ツールを踏まないので、
  // Policy Gate 経由では止まらず外部 I/O（モデル呼び出し）に達しうる経路。
  s.push("こんにちは");
  await drain();

  expect(model.calls.length).toBe(0); // 課金される外部呼び出しをしない
  expect(s.sent.length).toBe(0);

  await agent.destroy();
});

test("model.requested の記録が最初の失敗になってもモデルを呼ばない（外部 I/O の fail-closed）", async () => {
  const s = captureSurface();
  const a = captureAuditSink({ failFromAction: "model.requested" });
  const model = countingModelPlugin();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [a.plugin, createInMemoryMemoryPlugin(), model.plugin, s.plugin],
  );

  s.push("こんにちは");
  await drain();

  expect(a.written.map((e) => e.action)).toContain("turn.received"); // 受信までは残る
  expect(model.calls.length).toBe(0); // 呼ぶ前に止まる
  expect(s.sent.length).toBe(0);

  await agent.destroy();
});

test("mode 変更は監査が残ってから反映する（残せなければ切り替えない）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      a.plugin,
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );
  // biome-ignore lint/suspicious/noExplicitAny: __setMode はコア内部用の変更口（/russell config 相当）。
  const setMode = (agent.ctx as any).__setMode as (m: string) => Promise<boolean>;

  expect(await setMode("live")).toBe(true);
  expect(agent.ctx.runtime.mode()).toBe("live");
  const changed = a.written.find((e) => e.action === "mode.changed");
  expect(changed?.payload).toMatchObject({ from: "dryrun", to: "live" });

  // 監査が残せない状態では昇格させない（誰がいつ上げたか追えなくなるため）
  a.setFailing(true);
  expect(await setMode("dryrun")).toBe(false);
  expect(agent.ctx.runtime.mode()).toBe("live"); // 変わらない

  await agent.destroy();
});

test("sink 未登録でも記録は失われない（インメモリのリングバッファ）", async () => {
  const s = captureSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [
      createInMemoryMemoryPlugin(),
      scriptedModel('{"note":null,"shelf":"覚えておくこと","forget":null}').plugin,
      s.plugin,
    ],
  );

  s.push("こんにちは");
  await drain();

  const actions = agent.ctx.audit.recent().map((e) => e.action);
  expect(actions).toContain("turn.received");
  expect(actions).toContain("surface.send");
  // sink が無いだけでは degraded にしない（構成の選択であって障害ではない）
  expect(agent.ctx.audit.healthy()).toBe(true);

  await agent.destroy();
});
