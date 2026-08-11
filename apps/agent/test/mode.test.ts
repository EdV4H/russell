/**
 * 実行モード（§6.5 / #32）。env 不要。
 *
 * `off → dryrun → live` は宣言されているだけで、**判定に一度も使われていなかった**。
 * つまり dryrun でも実際に Slack へ投稿していた。「dryrun で妥当率を測ってから live へ
 * 昇格する」という運用が、そもそも成立していなかった。
 *
 * ここで固めたいのは「何が止まって、何が止まらないか」。運用が読む仕様そのものなので。
 */

import {
  createAgent,
  modeAllowsSend,
  modeAllowsTool,
  shouldPublishJournal,
} from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type { InboundMessage, Mode, RussellPlugin, Temperament } from "@edv4h/russell-shared";
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

// --- 判定（純関数） ---

test("live はすべて通す", () => {
  for (const effect of ["read", "internal_write", "external_write", "external_send"] as const) {
    expect(modeAllowsTool("live", effect)).toBe(true);
  }
  expect(modeAllowsSend("live")).toBe(true);
});

test("dryrun は外に出るものだけ止める（記憶は書く）", () => {
  expect(modeAllowsTool("dryrun", "read")).toBe(true);
  // **記憶は書く。** 記憶の挙動こそ試したい対象で、個体の内部に閉じている
  expect(modeAllowsTool("dryrun", "internal_write")).toBe(true);
  expect(modeAllowsTool("dryrun", "external_write")).toBe(false);
  expect(modeAllowsTool("dryrun", "irreversible_write")).toBe(false);
  // **返信も外部への送信。** ここを通すと「dryrun だから安全」が嘘になる
  expect(modeAllowsSend("dryrun")).toBe(false);
});

test("off は読み取りもしない（動いていないのと同じ）", () => {
  expect(modeAllowsTool("off", "read")).toBe(false);
  expect(modeAllowsTool("off", "internal_write")).toBe(false);
  expect(modeAllowsSend("off")).toBe(false);
});

// --- 認知ループ ---

function surface() {
  const sent: string[] = [];
  let sink: ((m: InboundMessage) => void) | undefined;
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake",
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
      messageId: "m1",
    });
  return { plugin, sent, push };
}

const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(mode: Mode) {
  const s = surface();
  const decision = '{"note":"覚えること","shelf":null,"title":null,"forget":null,"terms":[]}';
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode },
    [createInMemoryMemoryPlugin(), scriptedModel(decision, "こんにちは").plugin, s.plugin],
  );
  s.push("やあ");
  await drain();
  return { agent, sent: s.sent };
}

test("dryrun では送らないが、送るはずだった内容を監査に残す", async () => {
  const { agent, sent } = await run("dryrun");

  expect(sent).toEqual([]);
  const suppressed = agent.ctx.audit.recent().find((e) => e.action === "surface.send.suppressed");
  expect(suppressed?.payload).toMatchObject({ reason: "mode_dryrun" });
  // 本文は監査に入れない（A1-5）。長さだけ
  expect(JSON.stringify(suppressed?.payload)).not.toContain("こんにちは");

  await agent.destroy();
});

test("dryrun でも記憶は書く（記憶の挙動を試せる）", async () => {
  const { agent } = await run("dryrun");

  const tools = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  expect(tools).toContain("note.write");

  await agent.destroy();
});

test("live では送る", async () => {
  const { agent, sent } = await run("live");
  expect(sent).toEqual(["こんにちは"]);
  await agent.destroy();
});

test("off では記憶も書かない", async () => {
  const { agent, sent } = await run("off");

  expect(sent).toEqual([]);
  const denied = agent.ctx.audit.recent().find((e) => e.action === "policy.denied");
  expect(denied?.payload).toMatchObject({ reason: "mode_off" });

  await agent.destroy();
});

test("送るはずだった内容は event で見える（dryrun の目的）", async () => {
  const s = surface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "dryrun" },
    [createInMemoryMemoryPlugin(), scriptedModel(undefined, "本当は送りたい").plugin, s.plugin],
  );
  const seen: { text: string }[] = [];
  agent.ctx.events.on("surface:send-suppressed", (p) => seen.push(p as { text: string }));

  s.push("やあ");
  await drain();

  expect(seen[0]?.text).toBe("本当は送りたい");
  await agent.destroy();
});

// --- 日報の投稿判定（§10.1 / #32） ---

test("出来事が無い日は投稿しない（毎朝「何もなかった」を流さない）", () => {
  expect(shouldPublishJournal("live", 0)).toEqual({ publish: false, reason: "empty" });
});

test("dryrun では投稿しない。理由が分かる形で返す", () => {
  expect(shouldPublishJournal("dryrun", 3)).toEqual({ publish: false, reason: "mode_dryrun" });
  expect(shouldPublishJournal("off", 3)).toEqual({ publish: false, reason: "mode_off" });
});

test("live で出来事があれば投稿する", () => {
  expect(shouldPublishJournal("live", 1)).toEqual({ publish: true });
});

test("空の判定はモードより先に効く（live でも空なら出さない）", () => {
  // 順序が逆だと「live なので投稿→中身が空」という日報が毎朝流れる
  expect(shouldPublishJournal("live", 0).reason).toBe("empty");
});
