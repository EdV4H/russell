/**
 * 会議に参加する装備。env 不要（偽のプロバイダで通す）。
 *
 * **参加は外へ出る行為**——参加者一覧に名前が出て、その場の全員に見える。だから承認が要る。
 * 一方で**抜けるのは妨げない**。止める方向の行為に承認を挟むと「出たいのに出られない」が起きる。
 *
 * 本物の経路（Meet Media API）は申請と承認が要るので、それを待たずに中身を作れる形にしてある。
 */

import { createAgent } from "@edv4h/russell-core";
import { createFakeMeetingProvider, createMeetingPlugin } from "@edv4h/russell-plugin-meeting";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type { ApprovalRequest, RussellPlugin, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

const LINES = [
  { speaker: "丸山", text: "定例を始めます", at: "2026-08-13T01:00:00.000Z" },
  { speaker: "A-san", text: "配信の設定は来週で", at: "2026-08-13T01:00:30.000Z" },
];

function surfaceThatApproves(approved: boolean) {
  const asked: ApprovalRequest[] = [];
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake",
    setup(ctx) {
      ctx.surfaces.register({
        id: "fake",
        start() {},
        async send() {
          return { status: "succeeded" };
        },
        async requestApproval(req) {
          asked.push(req);
          return { approved, by: "U_ME" };
        },
      });
    },
  };
  return { plugin, asked };
}

async function withMeeting(approved = true, providerOptions = {}) {
  const provider = createFakeMeetingProvider({ script: LINES, ...providerOptions });
  const s = surfaceThatApproves(approved);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), createMeetingPlugin({ provider }), s.plugin],
  );
  return { agent, provider, asked: s.asked };
}

const ask = { surfaceId: "fake", contextId: "t1", requestedBy: "U_ME", summary: "会議" };

test("参加には承認が要る（参加者一覧に名前が出る行為なので）", async () => {
  const { agent, asked } = await withMeeting(true);

  await agent.invokeTool("meeting.join", { url: "https://meet.example/abc" }, "untrusted", ask);

  expect(asked).toHaveLength(1);
  expect(asked[0]?.effect).toBe("external_send");
  // 押す前に、どこへ入るかが見える
  expect(asked[0]?.summary).toContain("参加者一覧に出ます");
  expect(asked[0]?.previewText).toBe("https://meet.example/abc");

  await agent.destroy();
});

test("**却下されたら入らない**", async () => {
  const { agent, provider } = await withMeeting(false);

  await expect(
    agent.invokeTool("meeting.join", { url: "https://meet.example/abc" }, "untrusted", ask),
  ).rejects.toThrow();
  // 入っていないので、出ることもできない
  const left = (await agent.invokeTool("meeting.leave", {}, "trusted")) as { status: string };
  expect(left.status).toBe("failed");
  expect(provider.left).toBe(false);

  await agent.destroy();
});

test("**抜けるのに承認は要らない**（止める方向の行為は妨げない）", async () => {
  const { agent, provider, asked } = await withMeeting(true);
  await agent.invokeTool("meeting.join", { url: "https://meet.example/abc" }, "untrusted", ask);

  // 承認の文脈を渡さずに呼べる＝会話の外からでも出られる
  const left = (await agent.invokeTool("meeting.leave", {}, "trusted")) as {
    status: string;
    data: { lines: number };
  };

  expect(left.status).toBe("complete");
  expect(left.data.lines).toBe(2);
  expect(provider.left).toBe(true);
  expect(asked).toHaveLength(1); // 参加のときの1回だけ

  await agent.destroy();
});

test("**黙って乗り換えない**（前の会議に入ったままだと思っている人がいる）", async () => {
  const { agent } = await withMeeting(true);
  await agent.invokeTool("meeting.join", { url: "https://meet.example/1" }, "untrusted", ask);

  const second = (await agent.invokeTool(
    "meeting.join",
    { url: "https://meet.example/2" },
    "untrusted",
    ask,
  )) as { status: string };

  expect(second.status).toBe("failed");

  await agent.destroy();
});

test("入れなかったことを、入れたことにしない", async () => {
  const { agent } = await withMeeting(true, { failJoin: true });

  const result = (await agent.invokeTool(
    "meeting.join",
    { url: "https://meet.example/abc" },
    "untrusted",
    ask,
  )) as { status: string };

  expect(result.status).toBe("failed");

  await agent.destroy();
});

test("**文字起こしは、取っただけでは会話に出ない**", async () => {
  const { agent } = await withMeeting(true);
  await agent.invokeTool("meeting.join", { url: "https://meet.example/abc" }, "untrusted", ask);

  // 出た時点の戻り値は件数だけ。中身は含まない
  const left = (await agent.invokeTool("meeting.leave", {}, "trusted")) as {
    data: Record<string, unknown>;
  };
  expect(JSON.stringify(left.data)).not.toContain("定例を始めます");

  // 明示的に取り出したときだけ出る
  const transcript = (await agent.invokeTool("meeting.transcript", {}, "trusted")) as {
    data: { text: string };
    trustLabel: string;
  };
  expect(transcript.data.text).toContain("丸山: 定例を始めます");
  // 他人の発言なので untrusted のまま（来歴を消さない, §12-3）
  expect(transcript.trustLabel).toBe("untrusted");

  await agent.destroy();
});

test("溢れた分は捨てるが、**全部見たとは言わない**", async () => {
  const provider = createFakeMeetingProvider();
  const s = surfaceThatApproves(true);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), createMeetingPlugin({ provider, maxLines: 2 }), s.plugin],
  );
  await agent.invokeTool("meeting.join", { url: "https://meet.example/abc" }, "untrusted", ask);

  for (const line of ["あ", "い", "う"]) {
    provider.emit({ speaker: "丸山", text: line, at: "2026-08-13T01:00:00.000Z" });
  }
  const transcript = (await agent.invokeTool("meeting.transcript", {}, "trusted")) as {
    status: string;
    data: { lines: number };
  };

  expect(transcript.data.lines).toBe(2);
  expect(transcript.status).toBe("partial"); // 捨てた分があるので complete と名乗らない

  await agent.destroy();
});

test("経路が無ければ、装備そのものが存在しない（未支給, §9.2）", async () => {
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), createMeetingPlugin({})],
  );

  expect(agent.ctx.equipment.get("meeting")).toBeUndefined();
  expect(agent.ctx.tools.get("meeting.join")).toBeUndefined();

  await agent.destroy();
});
