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
import {
  type PendingSearchDeps,
  findContexts,
  findPendingMessages,
  pendingReply,
  withinWindow,
} from "@edv4h/russell-plugin-surface-slack";
import { PRESENCE_SERVICE } from "@edv4h/russell-shared";
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
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
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
      mode: "live",
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
      mode: "live",
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
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
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
      mode: "live",
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
      { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
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
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, plain],
  );
  await drain();

  expect(sent).toEqual([]);
  await agent.destroy();
});

// --- 探し方（実クライアント無しで検証する） ---

const now = () => new Date();
const ts = (minutesAgo: number) => String((Date.now() - minutesAgo * 60_000) / 1000);
/** 既定の窓（12時間前）。 */
const since = () => new Date(Date.now() - 12 * 60 * 60 * 1000);

/** 読める会話と、読めない会話を混ぜた偽の Slack。 */
function fakeSlack(over: Partial<PendingSearchDeps> = {}): PendingSearchDeps {
  return {
    since: new Date(Date.now() - 12 * 60 * 60 * 1000),
    limit: 3,
    botUserId: "UBOB",
    async listConversations() {
      return [{ id: "C1", isDm: false }];
    },
    async history() {
      return [{ user: "U1", text: "やあ", ts: ts(5), thread_ts: "100.1" } as never];
    },
    async messages() {
      return [
        { user: "UBOB", text: "確認します", ts: ts(10) },
        { user: "U1", text: "ありがとう、あと1つ", ts: ts(5) },
      ];
    },
    async names() {
      return new Map([["U1", "丸山"]]);
    },
    ...over,
  };
}

test("読めない会話があっても止まらず、読めなかった数を返す", async () => {
  const result = await findPendingMessages(
    fakeSlack({
      async listConversations() {
        return [
          { id: "C_BROKEN", isDm: false },
          { id: "C1", isDm: false },
        ];
      },
      async history(channel) {
        // 実データでは必ず混ざる（アーカイブ、消えたチャンネル、削除済みユーザーとの DM）
        if (channel === "C_BROKEN") throw new Error("channel_not_found");
        return [{ user: "U1", text: "やあ", ts: ts(5), thread_ts: "100.1" } as never];
      },
    }),
  );

  // **1つ読めないだけで全部止めない**——実際 channel_not_found で確認が丸ごと止まっていた
  expect(result.found).toHaveLength(1);
  // 0件が「無い」なのか「見られなかった」なのかは別物なので、必ず数える
  expect(result.skipped).toBe(1);
  // **理由も返す。** 数だけだと、直せるものかどうかが判断できない
  expect(result.reasons).toEqual(["channel_not_found"]);
});

test("読めなかった理由は、直せるものかどうかが分かる形で返る", async () => {
  const result = await findPendingMessages(
    fakeSlack({
      async listConversations() {
        return [
          { id: "C_NO_SCOPE", isDm: false },
          { id: "C_GONE", isDm: false },
          { id: "C_ALSO_GONE", isDm: false },
        ];
      },
      async history(channel) {
        // 権限不足は**こちらで直せる**。消えたチャンネルは直せない。この区別が要る
        if (channel === "C_NO_SCOPE") throw new Error("An API error occurred: missing_scope");
        throw new Error("An API error occurred: channel_not_found");
      },
    }),
  );

  expect(result.skipped).toBe(3);
  // 同じ理由は畳む（3件読めなくても、理由は2種類）
  expect([...result.reasons].sort()).toEqual(["channel_not_found", "missing_scope"]);
});

test("知らない失敗は「不明」として残す（黙って落とさない）", async () => {
  const result = await findPendingMessages(
    fakeSlack({
      async listConversations() {
        return [{ id: "C_WEIRD", isDm: false }];
      },
      async history() {
        throw new Error("socket hang up");
      },
    }),
  );

  expect(result.reasons).toEqual(["不明"]);
});

test("スレッドが1つ読めなくても、他のスレッドは見る", async () => {
  const result = await findPendingMessages(
    fakeSlack({
      async history() {
        return [
          { user: "U1", text: "a", ts: ts(5), thread_ts: "100.1" } as never,
          { user: "U1", text: "b", ts: ts(5), thread_ts: "200.1" } as never,
        ];
      },
      async messages(contextId) {
        if (contextId === "C1:100.1") throw new Error("thread_not_found");
        return [
          { user: "UBOB", text: "確認します", ts: ts(10) },
          { user: "U1", text: "その後どう？", ts: ts(5) },
        ];
      },
    }),
  );

  expect(result.found).toHaveLength(1);
  expect(result.skipped).toBe(1);
});

test("拾った発言には名前が付く（誰の発言か分かる）", async () => {
  const { found } = await findPendingMessages(fakeSlack());

  expect(found[0]?.author).toBe("U1"); // 監査は id
  expect(found[0]?.authorName).toBe("丸山"); // 会話は名前
});

test("名前が引けなくても拾う（名前は諦めるが、返信は諦めない）", async () => {
  const { found } = await findPendingMessages(
    fakeSlack({
      async names() {
        throw new Error("missing_scope");
      },
    }),
  );

  expect(found).toHaveLength(1);
  expect(found[0]?.authorName).toBeUndefined();
});

test("除外チャンネルは見ない", async () => {
  const { found } = await findPendingMessages(fakeSlack({ excludedChannels: new Set(["C1"]) }));
  expect(found).toEqual([]);
});

test("上限で打ち切る", async () => {
  const { found } = await findPendingMessages(
    fakeSlack({
      limit: 1,
      async listConversations() {
        return [
          { id: "C1", isDm: false },
          { id: "C2", isDm: false },
        ];
      },
    }),
  );
  expect(found).toHaveLength(1);
});

// --- どこを探すか（拾う場所の抜け） ---

test("**チャンネル直下の名指しを拾う**（スレッドではないので、これまで見えていなかった）", () => {
  // 実際に取りこぼした形: 2時間半前の `@Bob …` が「積み残し 0件」になった
  const at = ts(1);
  const contexts = findContexts(
    "C1",
    [{ user: "U1", text: "<@UBOB> これ見てもらえる？", ts: at }],
    since(),
    "UBOB",
  );

  expect(contexts).toEqual([`C1:${at}`]);
});

test("直下の雑談は拾わない（名指しだけ）", () => {
  // 全部拾うと「チャンネルを全部読んでいる」になる（通常の追従と同じ線引き）
  const contexts = findContexts(
    "C1",
    [{ user: "U1", text: "今日は暑いね", ts: ts(1) }],
    since(),
    "UBOB",
  );

  expect(contexts).toEqual([]);
});

test("**親が古くても、返信が新しければ拾う**", () => {
  // 返信し忘れの本命がここ。親の時刻で切ると一生拾えない
  const parent = ts(240); // 10日前に始まったスレッド
  const contexts = findContexts(
    "C1",
    [
      {
        user: "U1",
        text: "長く続いている相談",
        ts: parent,
        thread_ts: parent,
        latest_reply: ts(1),
      },
    ],
    since(),
    "UBOB",
  );

  expect(contexts).toEqual([`C1:${parent}`]);
});

test("動きが止まって久しいスレッドは拾わない", () => {
  const parent = ts(240);
  const contexts = findContexts(
    "C1",
    // 最後の返信が20時間前＝窓（12時間）の外
    [{ user: "U1", text: "終わった話", ts: parent, thread_ts: parent, latest_reply: ts(20 * 60) }],
    since(),
    "UBOB",
  );

  expect(contexts).toEqual([]);
});

test("同じスレッドの複数の発言は、根で1つに畳む", () => {
  const parent = ts(3);
  const contexts = findContexts(
    "C1",
    [
      { user: "U1", text: "親", ts: parent, thread_ts: parent, latest_reply: ts(1) },
      { user: "U2", text: "返信", ts: ts(1), thread_ts: parent },
    ],
    since(),
    "UBOB",
  );

  expect(contexts).toEqual([`C1:${parent}`]);
});

test("参加通知などは数えない", () => {
  const contexts = findContexts(
    "C1",
    [{ user: "U1", text: "<@UBOB> さんが参加しました", ts: ts(1), subtype: "channel_join" }],
    since(),
    "UBOB",
  );

  expect(contexts).toEqual([]);
});

test("**自分が誰か分からないまま探さない**（黙って0件と言わせない）", async () => {
  const result = await findPendingMessages(
    fakeSlack({
      botUserId: undefined, // 起動直後、イベントがまだ届いていない状態
      async history() {
        return [{ user: "U1", text: "<@UBOB> これ見てもらえる？", ts: ts(1) }];
      },
    }),
  );

  // 名指しの判定ができない。**探した結果0件**と**探せなかった**は別物なので、理由を返す
  expect(result.found).toEqual([]);
  expect(result.reasons).toEqual(["自分の id が分からない"]);
});

/**
 * 留守明け（#124）。**「古い話を掘り返さない」と「留守にしていた分に応える」は別のこと。**
 *
 * 4日間落ちていた間に来た呼びかけは、復帰時にはすべて既定の窓（12時間）の外にあり、
 * **一件も拾われなかった**。窓の広げ方そのものは catchup-window.test.ts で見ているので、
 * ここで確かめるのは**繋がっているか**——前回の稼働時刻が実際に使われ、
 * 起動直後の1回だけであること。
 */

/** 前回いつまで動いていたかを答えるだけのプラグイン（本番は監査プラグインが提供する）。 */
function presence(lastSeenAt: Date | undefined): RussellPlugin {
  return {
    id: "presence",
    name: "presence",
    setup(ctx) {
      ctx.services.provide(PRESENCE_SERVICE, { lastSeenAt: () => lastSeenAt });
    },
  };
}

test("**留守にしていた分まで遡って探す**", async () => {
  const away = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30時間前まで動いていた
  const s = catchupSurface([inbound("t1", "これお願いできる？")]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, presence(away), s.plugin],
  );
  await drain();

  // 既定の12時間ではなく、止まった時点まで遡っている
  const since = s.calls[0]?.since.getTime() ?? 0;
  expect(Math.abs(since - away.getTime())).toBeLessThan(2000);

  // **黙って広げない。** 普段と違う動きなので、後から辿れる形で残す
  const widened = agent.ctx.audit.recent().find((e) => e.action === "catchup.widened");
  expect(widened?.payload).toMatchObject({ capped: false });

  await agent.destroy();
});

test("**遡るのは起動直後の1回だけ**（動いている間は留守にしていない）", async () => {
  const away = new Date(Date.now() - 30 * 60 * 60 * 1000);
  const s = catchupSurface([]);
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      model: "echo",
      mode: "live",
      catchup: { intervalMs: 5 },
    },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, presence(away), s.plugin],
  );
  await new Promise((r) => setTimeout(r, 40));
  await drain();

  expect(s.calls.length).toBeGreaterThan(1);
  const first = s.calls[0]?.since.getTime() ?? 0;
  const later = s.calls[s.calls.length - 1]?.since.getTime() ?? 0;
  // 2回目以降は既定の窓。広げ続けると、古い話を毎回掘り返すことになる
  expect(later - first).toBeGreaterThan(10 * 60 * 60 * 1000);

  await agent.destroy();
});

test("**上限を超えて止まっていたら、打ち切ったことを残す**", async () => {
  const away = new Date(Date.now() - 96 * 60 * 60 * 1000); // 4日（実際に起きた形）
  const s = catchupSurface([]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, presence(away), s.plugin],
  );
  await drain();

  const widened = agent.ctx.audit.recent().find((e) => e.action === "catchup.widened");
  // 拾えなかった分があることは、言える形にしておく
  expect(widened?.payload).toMatchObject({ capped: true });
  // 3日より前へは行かない
  const since = s.calls[0]?.since.getTime() ?? 0;
  expect(Date.now() - since).toBeLessThan(73 * 60 * 60 * 1000);

  await agent.destroy();
});

test("前回が分からなければ、既定のまま動く（記録を持たない構成）", async () => {
  const s = catchupSurface([]);
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), scriptedModel().plugin, s.plugin],
  );
  await drain();

  const since = s.calls[0]?.since.getTime() ?? 0;
  expect(Math.abs(Date.now() - since - 12 * 60 * 60 * 1000)).toBeLessThan(2000);
  expect(agent.ctx.audit.recent().some((e) => e.action === "catchup.widened")).toBe(false);

  await agent.destroy();
});
