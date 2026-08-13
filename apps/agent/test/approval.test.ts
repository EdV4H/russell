/**
 * 人の承認（HITL, §12-2）。env 不要。
 *
 * 外へ出る行為（`external_write` など）は、これまで**無条件で拒否**されていた。
 * 承認はその原則を緩めるのではなく、**人を1人挟む**ためのものである。
 *
 * ここで固めたいのは「承認できること」より、**承認が取れなければ実行しない**こと。
 * 返らない答え・聞けない構成・期限切れは、全部「実行しない」へ倒す。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import {
  approvalBlocks,
  createApprovalDesk,
  decidedText,
  mayApprove,
} from "@edv4h/russell-plugin-surface-slack";
import type {
  ApprovalOutcome,
  ApprovalRequest,
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

/** 外へ書く道具を1つ持つ通信面。承認の可否を差し替えられる。 */
function externalTool(answer?: (req: ApprovalRequest) => Promise<ApprovalOutcome>) {
  const ran: unknown[] = [];
  const asked: ApprovalRequest[] = [];
  const plugin: RussellPlugin = {
    id: "ext",
    name: "ext",
    setup(ctx) {
      ctx.policy.declareEffect("doc.create", "external_write");
      ctx.tools.register("doc.create", {
        name: "doc.create",
        effect: "external_write",
        async run(input: unknown) {
          ran.push(input);
          return { status: "succeeded" as const };
        },
      });
      ctx.surfaces.register({
        id: "fake",
        start() {},
        async send() {
          return { status: "succeeded" };
        },
        ...(answer
          ? {
              async requestApproval(req: ApprovalRequest) {
                asked.push(req);
                return await answer(req);
              },
            }
          : {}),
      });
    },
  };
  return { plugin, ran, asked };
}

async function agentWith(ext: ReturnType<typeof externalTool>) {
  return await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), ext.plugin],
  );
}

const ask = {
  surfaceId: "fake",
  contextId: "t1",
  requestedBy: "U_ME",
  summary: "Notion に議事録を作る",
};

test("承認されれば実行する", async () => {
  const ext = externalTool(async () => ({ approved: true, by: "U_ME" }));
  const agent = await agentWith(ext);

  await agent.invokeTool("doc.create", { title: "議事録" }, "untrusted", ask);

  expect(ext.ran).toHaveLength(1);
  await agent.destroy();
});

test("**却下されたら実行しない**", async () => {
  const ext = externalTool(async () => ({ approved: false, by: "U_ME" }));
  const agent = await agentWith(ext);

  await expect(
    agent.invokeTool("doc.create", { title: "議事録" }, "untrusted", ask),
  ).rejects.toThrow();
  expect(ext.ran).toEqual([]);

  await agent.destroy();
});

test("**聞けない構成では実行しない**（承認は原則を緩めるものではない）", async () => {
  const ext = externalTool(); // requestApproval を持たない通信面
  const agent = await agentWith(ext);

  await expect(
    agent.invokeTool("doc.create", { title: "議事録" }, "untrusted", ask),
  ).rejects.toThrow();
  expect(ext.ran).toEqual([]);

  await agent.destroy();
});

test("**依頼の文脈が無ければ聞かずに拒否**（従来どおり）", async () => {
  const ext = externalTool(async () => ({ approved: true }));
  const agent = await agentWith(ext);

  await expect(agent.invokeTool("doc.create", { title: "x" }, "untrusted")).rejects.toThrow();
  expect(ext.asked).toEqual([]);
  expect(ext.ran).toEqual([]);

  await agent.destroy();
});

test("聞くときに、何をするのかを渡す（押す人が判断できるように）", async () => {
  const ext = externalTool(async () => ({ approved: false }));
  const agent = await agentWith(ext);

  await expect(
    agent.invokeTool("doc.create", { title: "x" }, "untrusted", {
      ...ask,
      previewText: "本文の下書き",
    }),
  ).rejects.toThrow();

  const req = ext.asked[0];
  expect(req?.tool).toBe("doc.create");
  expect(req?.effect).toBe("external_write");
  expect(req?.requestedBy).toBe("U_ME");
  expect(req?.previewText).toBe("本文の下書き");
  expect(new Date(req?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());

  await agent.destroy();
});

test("承認の記録が監査に残る（理由の本文は残さない）", async () => {
  const ext = externalTool(async () => ({ approved: true, by: "U_BOSS", reason: "いいよ" }));
  const agent = await agentWith(ext);

  await agent.invokeTool("doc.create", { title: "x" }, "untrusted", ask);

  const events = agent.ctx.audit.recent();
  const requested = events.find((e) => e.action === "approval.requested");
  const decided = events.find((e) => e.action === "approval.decided");
  expect(requested?.payload.tool).toBe("doc.create");
  expect(decided?.payload.approved).toBe(true);
  expect(decided?.actor).toBe("U_BOSS"); // 誰が決めたか
  expect(JSON.stringify(decided?.payload)).not.toContain("いいよ"); // 理由は残さない（A1-5）

  await agent.destroy();
});

// --- 通信面側（誰が押してよいか・期限） ---

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  contextId: "C1:1",
  summary: "Notion に議事録を作る",
  tool: "doc.create",
  effect: "external_write",
  requestedBy: "U_ME",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

test("押せるのは依頼者本人か運用者だけ", () => {
  const isOperator = (id: string) => id === "U_BOSS";

  expect(mayApprove("U_ME", req(), isOperator)).toBe(true); // 依頼者
  expect(mayApprove("U_BOSS", req(), isOperator)).toBe(true); // 運用者
  expect(mayApprove("U_OTHER", req(), isOperator)).toBe(false); // 居合わせただけの人
  // 依頼者が分からないときは、運用者だけ
  expect(mayApprove("U_OTHER", req({ requestedBy: undefined }), isOperator)).toBe(false);
});

test("押す前に、何が起きるかが見える", () => {
  const blocks = approvalBlocks(req({ previewText: "本文の下書き" }), "ap-1");
  const json = JSON.stringify(blocks);

  expect(json).toContain("Notion に議事録を作る");
  expect(json).toContain("外部への書き込み"); // 効果分類を人の言葉で
  expect(json).toContain("doc.create");
  expect(json).toContain("本文の下書き"); // 中身も見せる
  expect(json).toContain("実行しません"); // 押さなければどうなるか
  expect(json).toContain("russell_approve");
});

test("決まった後は、誰がどうしたかがその場に残る", () => {
  expect(decidedText(req(), { approved: true, by: "U_BOSS" })).toContain("<@U_BOSS>");
  expect(decidedText(req(), { approved: true, by: "U_BOSS" })).toContain("承認");
  expect(decidedText(req(), { approved: false, by: "U_BOSS" })).toContain("却下");
  expect(decidedText(req(), { approved: false, reason: "expired" })).toContain("期限切れ");
});

test("**期限が来たら却下として扱う**", async () => {
  const desk = createApprovalDesk();
  const expired: string[] = [];
  const { promise } = desk.open(req({ expiresAt: new Date(Date.now() + 5).toISOString() }), (n) =>
    expired.push(n),
  );

  const outcome = await promise;

  expect(outcome).toEqual({ approved: false, reason: "expired" });
  expect(expired).toHaveLength(1); // 投稿を書き換えるために通知される
  expect(desk.size).toBe(0);
});

test("知らない引換券は通さない（再起動後・二度押し）", () => {
  const desk = createApprovalDesk();
  const { nonce } = desk.open(req(), () => {});

  expect(desk.close(nonce, { approved: true, by: "U_ME" })).toBeDefined();
  // 2回目は残っていない
  expect(desk.close(nonce, { approved: true, by: "U_ME" })).toBeUndefined();
  expect(desk.close("知らない券", { approved: true, by: "U_ME" })).toBeUndefined();
});

// --- 会話から書く（調べものの経路に合流する） ---

test("書く要求には承認の画面を出し、**中身をそのまま見せる**", async () => {
  const asked: ApprovalRequest[] = [];
  const ran: unknown[] = [];
  const plugin: RussellPlugin = {
    id: "ext",
    name: "ext",
    setup(ctx) {
      ctx.policy.declareEffect("doc.create", "external_write");
      ctx.equipment.register({
        id: "doc",
        mcpServer: {},
        scopes: [],
        dangerLevel: 0,
        tools: () => [{ name: "doc.create", effect: "external_write" }],
      });
      ctx.tools.register("doc.create", {
        name: "doc.create",
        effect: "external_write",
        async run(input: unknown) {
          ran.push(input);
          return { status: "succeeded" as const };
        },
      });
    },
  };
  let sink: ((m: never) => void) | undefined;
  const sent: string[] = [];
  const surfacePlugin: RussellPlugin = {
    id: "fake",
    name: "fake",
    setup(ctx) {
      ctx.surfaces.register({
        id: "fake",
        start(s) {
          sink = s as never;
        },
        async send(o) {
          sent.push(o.text);
          return { status: "succeeded" };
        },
        async requestApproval(req) {
          asked.push(req);
          return { approved: true, by: "U_ME" };
        },
      });
    },
  };
  const model: RussellPlugin = {
    id: "m",
    name: "m",
    setup(ctx) {
      let n = 0;
      ctx.models.register({
        id: "echo",
        async complete(req) {
          if (req.system.includes("記憶係")) return { text: "{}" };
          n += 1;
          return n === 1
            ? {
                text: '{"lookup": {"tool": "doc.create", "input": {"title": "議事録", "body": "決まったこと"}}}',
              }
            : { text: "承認ありがとうございます。作りました" };
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), plugin, model, surfacePlugin],
  );
  (sink as (m: unknown) => void)({
    surfaceId: "fake",
    contextId: "t1",
    author: "U_ME",
    text: "議事録を作っておいて",
    trustLabel: "untrusted",
    isMention: true,
    messageId: "m1",
  });
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));

  expect(asked).toHaveLength(1);
  expect(asked[0]?.summary).toContain("議事録");
  // **中身をそのまま見せる。** 要約を見せると、押す人は要約を承認することになる
  expect(asked[0]?.previewText).toBe("決まったこと");
  expect(asked[0]?.requestedBy).toBe("U_ME");
  expect(ran).toHaveLength(1);

  await agent.destroy();
});
