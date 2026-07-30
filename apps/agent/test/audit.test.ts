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
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type { AuditEvent, InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
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
      author: "u-slack-123",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, sent, push };
}

/** 監査 sink のテストダブル。failing=true で全 write を失敗させる（DB 障害の模擬）。 */
function captureAuditSink(opts: { failing?: boolean } = {}) {
  const written: AuditEvent[] = [];
  let failing = opts.failing ?? false;
  const plugin: RussellPlugin = {
    id: "fake-audit",
    name: "fake audit sink",
    setup(ctx) {
      return ctx.audit.registerSink({
        id: "fake-audit",
        async write(event) {
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

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

test("全アクションが trust_label 付きで event_log に残る（横断ゲート）", async () => {
  const s = captureSurface();
  const a = captureAuditSink();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [a.plugin, createInMemoryMemoryPlugin(), createEchoModelPlugin(), s.plugin],
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
    [a.plugin, createInMemoryMemoryPlugin(), createEchoModelPlugin(), s.plugin],
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
    [a.plugin, createInMemoryMemoryPlugin(), createEchoModelPlugin(), s.plugin],
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
    [a.plugin, rogue, createEchoModelPlugin(), s.plugin],
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
    [a.plugin, createInMemoryMemoryPlugin(), createEchoModelPlugin(), s.plugin],
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

test("sink 未登録でも記録は失われない（インメモリのリングバッファ）", async () => {
  const s = captureSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [createInMemoryMemoryPlugin(), createEchoModelPlugin(), s.plugin],
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
