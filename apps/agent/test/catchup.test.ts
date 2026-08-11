/**
 * 積み残しの確認（返信し忘れの拾い直し）。env 不要。
 *
 * Bob が黙る原因は1つではない（落ちていた・再起動中だった・イベントが届かなかった・
 * ターンが例外で落ちた）。個別に潰しても次の原因が現れるので、**結果の側から回復する**。
 *
 * ここで固めたい性質は2つ:
 * - **二重に返信しない**（「最後の発言が自分か」で決まるので、返した時点で対象から外れる）
 * - **勝手に古い話を掘り返さない**（窓と件数で必ず頭を打つ）
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { pendingReply, withinWindow } from "@edv4h/russell-plugin-surface-slack";
import type { InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
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

const BOT = "U_BOB";
const msg = (user: string, text: string, ts = "1700000000.000100") => ({ user, text, ts });

// --- 判定（純関数） ---

test("最後が相手の発言で、自分が関与していれば返信が要る", () => {
  const p = pendingReply(
    [msg("U1", "この件どう思う？"), msg(BOT, "確認します"), msg("U1", "ありがとう、あと1つ")],
    BOT,
  );
  expect(p?.text).toBe("ありがとう、あと1つ");
  expect(p?.author).toBe("U1");
});

test("最後が自分の発言なら返信は済んでいる", () => {
  const p = pendingReply([msg("U1", "お願いします"), msg(BOT, "できました")], BOT);
  expect(p).toBeUndefined();
});

test("一度も発言していないスレッドには入らない（呼ばれてもいない会話）", () => {
  expect(pendingReply([msg("U1", "AとBどっちがいい？"), msg("U2", "Bかな")], BOT)).toBeUndefined();
});

test("関与していなくても、名指しされていれば拾う", () => {
  const p = pendingReply([msg("U1", "これ <@U_BOB> どう思う？")], BOT);
  expect(p?.text).toBe("これ どう思う？");
});

test("参加通知や空の発言は数えない", () => {
  const messages = [
    msg(BOT, "よろしくお願いします"),
    { user: "U1", text: "が参加しました", ts: "1700000000.000200", subtype: "channel_join" },
    { user: "U1", text: "", ts: "1700000000.000300" },
  ];
  // 実体のある最後の発言は自分のもの → 返信は要らない
  expect(pendingReply(messages, BOT)).toBeUndefined();
});

test("窓の外の発言は拾わない（古い話を掘り返さない）", () => {
  const now = Date.now();
  const since = new Date(now - 12 * 60 * 60 * 1000);
  const recent = String((now - 60_000) / 1000);
  const old = String((now - 48 * 60 * 60 * 1000) / 1000);

  expect(withinWindow(recent, since)).toBe(true);
  expect(withinWindow(old, since)).toBe(false);
  expect(withinWindow(undefined, since)).toBe(false);
});

// --- コアの拾い直し ---

/** pendingMessages を持つ通信面。返した後は「返信済み」になる（Slack の挙動に合わせる）。 */
function catchupSurface(pending: InboundMessage[]) {
  const sent: string[] = [];
  const calls: { since: Date; limit: number }[] = [];
  let queue = [...pending];
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake surface",
    setup(ctx) {
      return ctx.surfaces.register({
        id: "fake",
        start() {},
        async send(o) {
          sent.push(o.text);
          // 返信したやりとりは対象から外れる（最後の発言が自分になるため）
          queue = queue.filter((m) => m.contextId !== o.contextId);
          return { status: "succeeded" };
        },
        async pendingMessages(opts) {
          calls.push(opts);
          return queue.slice(0, opts.limit);
        },
      });
    },
  };
  return { plugin, sent, calls };
}

const inbound = (contextId: string, text: string): InboundMessage => ({
  surfaceId: "fake",
  contextId,
  author: "U1",
  text,
  trustLabel: "untrusted",
  isMention: true,
  messageId: `${contextId}-m`,
});

const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

test("起動直後に積み残しを拾って返信する", async () => {
  const s = catchupSurface([inbound("t1", "これお願いできる？")]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
  );
  await drain();

  expect(s.sent).toHaveLength(1);
  const found = agent.ctx.audit.recent().find((e) => e.action === "catchup.found");
  expect(found?.payload).toMatchObject({ surfaceId: "fake", count: 1 });

  await agent.destroy();
});

test("返信したものは次の確認で対象にならない（二重返信しない）", async () => {
  const s = catchupSurface([inbound("t1", "お願い")]);
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      model: "echo",
      catchup: { intervalMs: 5 },
    },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
  );
  await drain();
  await new Promise((r) => setTimeout(r, 30));
  await drain();

  expect(s.calls.length).toBeGreaterThan(1); // 何度も確認しているが
  expect(s.sent).toHaveLength(1); // 返信は1回だけ

  await agent.destroy();
});

test("上限を超えて一度に返信しない", async () => {
  const s = catchupSurface([
    inbound("t1", "1つ目"),
    inbound("t2", "2つ目"),
    inbound("t3", "3つ目"),
    inbound("t4", "4つ目"),
  ]);
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      model: "echo",
      catchup: { limit: 2, intervalMs: 0 },
    },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
  );
  await drain();

  expect(s.sent).toHaveLength(2);
  expect(s.calls[0]?.limit).toBe(2);

  await agent.destroy();
});

test("窓は既定12時間で、通信面に渡される", async () => {
  const s = catchupSurface([]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
  );
  await drain();

  const since = s.calls[0]?.since.getTime() ?? 0;
  const expected = Date.now() - 12 * 60 * 60 * 1000;
  expect(Math.abs(since - expected)).toBeLessThan(5000);

  await agent.destroy();
});

test("無効にできる", async () => {
  const s = catchupSurface([inbound("t1", "お願い")]);
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      model: "echo",
      catchup: { enabled: false },
    },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
  );
  await drain();

  expect(s.calls).toEqual([]);
  expect(s.sent).toEqual([]);

  await agent.destroy();
});

test("凍結中は拾い直さない（§12-4）", async () => {
  const s = catchupSurface([inbound("t1", "お願い")]);
  process.env.RUSSELL_KILL = "1";
  try {
    const agent = await createAgent(
      { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
      [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
    );
    await drain();
    expect(s.calls).toEqual([]);
    expect(s.sent).toEqual([]);
    await agent.destroy();
  } finally {
    process.env.RUSSELL_KILL = "0";
  }
});

test("pendingMessages を持たない通信面は素通りする", async () => {
  const sent: string[] = [];
  const plain: RussellPlugin = {
    id: "plain",
    name: "plain",
    setup(ctx) {
      return ctx.surfaces.register({
        id: "plain",
        start() {},
        async send(o) {
          sent.push(o.text);
          return { status: "succeeded" };
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, plain],
  );
  await drain();

  expect(sent).toEqual([]);
  await agent.destroy();
});
