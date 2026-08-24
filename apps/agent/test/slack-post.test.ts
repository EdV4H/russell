/**
 * 装備としての Slack：**別のチャンネルへ投稿する**（env 不要・偽の client で通す）。
 *
 * 面としての返事とは別物である。返事は相手のいる場所へ戻すだけだが、こちらは
 * **持っていく先を選ぶ**——だから承認が要り、承認画面には宛先と本文の両方を出す。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { channelLabel, registerSlackPost } from "@edv4h/russell-plugin-surface-slack";
import type { Mode, RussellPlugin, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/** Slack の API の代わり。投稿を記録し、決めた応答を返す。 */
function fakeSlack(over: { postFails?: string; channelName?: string } = {}) {
  const posted: { channel: string; text: string }[] = [];
  const client = {
    chat: {
      async postMessage(args: { channel: string; text: string }) {
        if (over.postFails) throw new Error(over.postFails);
        posted.push({ channel: args.channel, text: args.text });
        return { ts: "1787000000.000100" };
      },
    },
    conversations: {
      async info() {
        if (!over.channelName) throw new Error("channel_not_found");
        return { channel: { name: over.channelName } };
      },
    },
  };
  return { posted, client: client as never };
}

/**
 * 承認する人がいる面。**投稿は承認が要る**ので、これが無いと何も通らない
 * （それ自体は正しい挙動なので、ここでは通した先を確かめる）。
 */
async function withSlackPost(slack: ReturnType<typeof fakeSlack>, mode: Mode = "live") {
  const plugin: RussellPlugin = {
    id: "slack-ish",
    name: "slack",
    setup(ctx) {
      const off = registerSlackPost(ctx, { client: slack.client });
      ctx.surfaces.register({
        id: "fake",
        start() {},
        async send() {
          return { status: "succeeded" };
        },
        async requestApproval() {
          return { approved: true, by: "U_ME" };
        },
      });
      return off;
    },
  };
  return await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode, model: "echo" },
    [createInMemoryMemoryPlugin(), plugin],
  );
}

/** 押す人がいる文脈。これが無いと聞きに行けないので拒否になる。 */
const ask = {
  surfaceId: "fake",
  contextId: "t1",
  requestedBy: "U_ME",
  summary: "Slack へ投稿する",
};

test("装備として登録され、投稿の道具を持つ", async () => {
  const agent = await withSlackPost(fakeSlack());

  const eq = agent.ctx.equipment.get("slack");
  expect(eq?.tools().map((t) => t.name)).toEqual(["slack.post"]);
  // **投稿は送信である。** 書き込みではない——届いた先の全員に見える
  expect(eq?.tools()[0]?.effect).toBe("external_send");
  expect(eq?.dangerLevel).toBe(1);

  await agent.destroy();
});

test("投稿できる", async () => {
  const slack = fakeSlack();
  const agent = await withSlackPost(slack);

  const result = (await agent.invokeTool(
    "slack.post",
    { channel: "#team", text: "決まったこと: 配信は来週へ" },
    "untrusted",
    ask,
  )) as { status: string };

  expect(result.status).toBe("complete");
  expect(slack.posted).toHaveLength(1);
  expect(slack.posted[0]?.channel).toBe("#team");

  await agent.destroy();
});

test("**宛先か本文が無ければ投稿しない**（承認を通っても、空は流さない）", async () => {
  const slack = fakeSlack();
  const agent = await withSlackPost(slack);

  const post = (input: unknown) => agent.invokeTool("slack.post", input, "untrusted", ask);
  expect(((await post({ channel: "#team", text: " " })) as { status: string }).status).toBe(
    "failed",
  );
  expect(((await post({ text: "本文だけ" })) as { status: string }).status).toBe("failed");
  expect(slack.posted).toHaveLength(0);

  await agent.destroy();
});

test("**届いたか分からないときに投げ直さない。** 理由は残す", async () => {
  const slack = fakeSlack({ postFails: "channel_not_found" });
  const agent = await withSlackPost(slack);

  const result = (await agent.invokeTool(
    "slack.post",
    { channel: "C0XXXXXX", text: "本文" },
    "untrusted",
    ask,
  )) as { status: string; detail?: string };

  expect(result.status).toBe("failed");
  // 「宛先が無い」と「権限が足りない」は、人がやることが違う
  expect(result.detail).toContain("channel_not_found");

  await agent.destroy();
});

test("**dryrun では投稿しない**（本番ワークスペースに繋いでも出ない）", async () => {
  const slack = fakeSlack();
  const agent = await withSlackPost(slack, "dryrun");

  // 承認が通っても投稿しない。**モードは承認より外側**にある
  await expect(
    agent.invokeTool("slack.post", { channel: "#team", text: "本文" }, "untrusted", ask),
  ).rejects.toThrow();
  expect(slack.posted).toHaveLength(0);

  await agent.destroy();
});

test("**承認を聞ける文脈が無ければ投稿しない**", async () => {
  const slack = fakeSlack();
  const agent = await withSlackPost(slack);

  // 承認は原則を緩めるものではない。聞けないなら実行しない（§12-2）
  await expect(
    agent.invokeTool("slack.post", { channel: "#team", text: "本文" }),
  ).rejects.toThrow();
  expect(slack.posted).toHaveLength(0);

  await agent.destroy();
});

test("承認画面には、どこへ・何を、の両方が出る", async () => {
  const slack = fakeSlack({ channelName: "team" });
  const agent = await withSlackPost(slack);

  const spec = agent.ctx.tools.get("slack.post");
  const described = await spec?.describe?.({ channel: "C0ABCDEFG", text: "決まったこと: 延期" });

  // id のままでは、押す人に投稿先が分からない
  expect(described?.summary).toContain("#team");
  expect(described?.preview).toContain("決まったこと");

  await agent.destroy();
});

test("**引けなかった宛先は、そのまま見せる**（推測で名前を作らない）", async () => {
  const slack = fakeSlack(); // conversations.info が失敗する
  const label = await channelLabel(slack.client, "C0ABCDEFG");

  // 間違った安心を与えない。引けなかったことは引けなかったまま出す
  expect(label).toBe("C0ABCDEFG");
});

test("id でない宛先は、そのまま読める形なので引きに行かない", async () => {
  const slack = fakeSlack({ channelName: "別のチャンネル" });

  expect(await channelLabel(slack.client, "#team")).toBe("#team");
});
