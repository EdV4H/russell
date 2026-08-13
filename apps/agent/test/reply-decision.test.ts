/**
 * 返すかどうかの判断（グループのスレッド対策）。env 不要。
 *
 * 「参加しているスレッドの続き＝自分への発話」としていたので、**3人以上のスレッドでは
 * 人同士の会話にも全部返信していた**（鬱陶しいと言われた）。
 *
 * **拾うか（追従）と、返すか（宛先）は別の判断**。ここで固めたいのは、
 * 決定論で即決できる範囲と、**迷ったら黙る**方向に倒っていること。
 */

import {
  buildReplyJudgeRequest,
  createAgent,
  decideReply,
  parseReplyJudgement,
} from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import {
  CONVERSATION_SERVICE,
  type InboundMessage,
  KILL_SWITCH_SERVICE,
  type KillSwitchCapability,
  type Mode,
  type ModelTurn,
  type RussellPlugin,
  type Temperament,
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

const ctx = (over: Partial<Parameters<typeof decideReply>[0]> = {}) => ({
  isMention: false,
  text: "で、どうする？",
  selfName: "Bob",
  history: [] as ModelTurn[],
  ...over,
});

const group: ModelTurn[] = [
  { role: "user", text: "これどう思う？", speaker: "丸山" },
  { role: "assistant", text: "こう思います" },
  { role: "user", text: "なるほどね", speaker: "A-san" },
];

test("名指しされたら返す", () => {
  expect(decideReply(ctx({ isMention: true, history: group }))).toEqual({
    reply: true,
    reason: "mentioned",
  });
});

const oneOnOne: ModelTurn[] = [
  { role: "user", text: "お願い", speaker: "丸山" },
  { role: "assistant", text: "承知しました" },
];

test("1対1で本文に名前が出てきたら返す（@ を付けない人は多い）", () => {
  expect(decideReply(ctx({ text: "Bob どう思う？", speaker: "丸山", history: oneOnOne }))).toEqual({
    reply: true,
    reason: "named",
  });
});

test("3人以上では、名前が出てきても即決しない（自分について話しているだけかもしれない）", () => {
  // 「Bob に聞いてみたら？」は Bob **について**の発言で、Bob 宛ではない
  expect(
    decideReply(ctx({ text: "Bob に聞いてみたら？", speaker: "A-san", history: group })),
  ).toEqual({ reply: false, reason: "ask_model" });
});

test("相手が1人だけのスレッドなら返す（宛先が自明）", () => {
  expect(decideReply(ctx({ speaker: "丸山", history: oneOnOne }))).toEqual({
    reply: true,
    reason: "one_on_one",
  });
});

test("履歴が無いときも返す（判断材料が無いのに黙らない）", () => {
  expect(decideReply(ctx({ speaker: "丸山" })).reply).toBe(true);
});

test("3人以上で名指しでなければ、決定論では決めない", () => {
  // **ここが今回の本体**。以前は無条件に返していた
  expect(decideReply(ctx({ speaker: "A-san", history: group }))).toEqual({
    reply: false,
    reason: "ask_model",
  });
});

test("3人目の初回発言を「1対1」と数えない", () => {
  // 履歴の発言者は丸山だけ。**いまの発言者を数えないと素通りする**——
  // 3人目が入ってきた最初の1回を必ず拾ってしまい、それがいちばん鬱陶しい
  expect(decideReply(ctx({ speaker: "B-san", history: oneOnOne }))).toEqual({
    reply: false,
    reason: "ask_model",
  });
});

test("同じ人の続けての発言は、2人に数えない", () => {
  expect(decideReply(ctx({ speaker: "丸山", history: oneOnOne })).reply).toBe(true);
});

test("履歴が id、いまの発言が表示名でも、同じ人として数える", () => {
  // **実際に踏んだ。** 通信面が履歴に id を入れていたので、1対1のスレッドが2人に見え、
  // 判定モデルへ回り、直接聞かれた質問に黙った
  const byId: ModelTurn[] = [
    { role: "user", text: "お願い", speaker: "U0BNJ3R4BFD" },
    { role: "assistant", text: "承知しました" },
  ];

  expect(decideReply(ctx({ speaker: "丸山", speakerId: "U0BNJ3R4BFD", history: byId }))).toEqual({
    reply: true,
    reason: "one_on_one",
  });
});

test("別人なら、id と表示名が混ざっていても2人に数える", () => {
  const byId: ModelTurn[] = [
    { role: "user", text: "お願い", speaker: "U_OTHER" },
    { role: "assistant", text: "承知しました" },
  ];

  expect(decideReply(ctx({ speaker: "丸山", speakerId: "U_ME", history: byId }))).toEqual({
    reply: false,
    reason: "ask_model",
  });
});

test("判定の軸は「宛先か」ではなく「自分が出てくるか」", () => {
  // 宛先だけを聞いていたら、**自分の話をされているのに黙った**（実測 3/3）。
  // 名前も @ も出さずに本人のことを話す発言に反応しない
  const req = buildReplyJudgeRequest(ctx({ history: group }));

  expect(req.system).toContain("あなたのことを話している");
  // 三人称でも自分のことなら拾う
  expect(req.system).toContain("三人称");
  // 「人同士の会話だから no」と読まれないように、明示で打ち消してある
  expect(req.system).toContain("人同士の会話であっても、あなたの話をしているなら yes");
});

test("気質は判定の傾きだけを動かす（既定の帯では何も足さない）", () => {
  const base = buildReplyJudgeRequest(ctx({ history: group })).system;

  // Bob の 0.7 は既定の帯。**実測して落ち着いた文面をそのまま使う**
  expect(buildReplyJudgeRequest(ctx({ history: group, reactionRate: 0.7 })).system).toBe(base);
  // 外れたときだけ一行足す
  expect(buildReplyJudgeRequest(ctx({ history: group, reactionRate: 0.2 })).system).toContain(
    "よほど自分宛でなければ no",
  );
  expect(buildReplyJudgeRequest(ctx({ history: group, reactionRate: 0.9 })).system).toContain(
    "少し前のめりに yes",
  );
});

test("気質では決定論の分岐を変えない（呼ばれて黙る個体は故障に見える）", () => {
  // 口数が少ない設定でも、名指しと1対1は即決で返す
  expect(decideReply(ctx({ isMention: true, reactionRate: 0, history: group })).reply).toBe(true);
  expect(decideReply(ctx({ speaker: "丸山", reactionRate: 0, history: oneOnOne })).reply).toBe(
    true,
  );
});

test("自分が出てこなければ黙る、と指示している", () => {
  const req = buildReplyJudgeRequest(ctx({ history: group }));

  expect(req.system).toContain("自分が出てこないなら no");
  expect(req.system).toContain("あなたの名前: Bob");
});

test("判定には誰の発言かが渡る（複数人の会話が1人に見えない）", () => {
  const req = buildReplyJudgeRequest(ctx({ speaker: "A-san", history: group }));

  expect(req.user).toContain("丸山: これどう思う？");
  expect(req.user).toContain("A-san: なるほどね");
  expect(req.user).toContain("Bob: こう思います");
  // 判定対象そのものにも発言者を付ける（誰が言ったかで宛先の見え方が変わる）
  expect(req.user).toContain("A-san: で、どうする？");
});

test("読み取りは3択。**読めなければ黙る**", () => {
  expect(parseReplyJudgement("yes")).toBe("reply");
  expect(parseReplyJudgement("Yes, あなた宛です")).toBe("reply");
  expect(parseReplyJudgement("stamp")).toBe("react");
  expect(parseReplyJudgement("no")).toBe("silent");
  expect(parseReplyJudgement("")).toBe("silent");
  // 説明を返してきた場合も、頭が読めなければ黙る。
  // **印だけ付ける側へ落とさない**——意味を取り違えたまま何か出す方が、何も出さないより悪い
  expect(parseReplyJudgement("これは丸山さんとA-sanの会話です")).toBe("silent");
});

// --- 認知ループを通した挙動 ---

function judgeModel(answer: string, reply = "はい") {
  const requests: { system: string; user: string }[] = [];
  const plugin: RussellPlugin = {
    id: "judge",
    name: "judge",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          requests.push(req);
          if (req.system.includes("口を開くべきか")) return { text: answer };
          if (req.system.includes("記憶係")) return { text: "{}" };
          return { text: reply };
        },
      });
    },
  };
  return { plugin, requests };
}

function threadSurface() {
  const sent: string[] = [];
  const reacted: string[] = [];
  let sink: ((m: InboundMessage) => void) | undefined;
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake",
    setup(ctx) {
      // 3人のスレッドを会話履歴として返す
      ctx.services.provide(CONVERSATION_SERVICE, {
        async history() {
          return [
            { role: "user" as const, text: "これどう？", speaker: "丸山" },
            { role: "assistant" as const, text: "こうです" },
            { role: "user" as const, text: "なるほど", speaker: "A-san" },
          ];
        },
      });
      return ctx.surfaces.register({
        id: "fake",
        start(s) {
          sink = s;
        },
        async send(o) {
          sent.push(o.text);
          return { status: "succeeded" };
        },
        async react(r) {
          reacted.push(r.kind);
          return { status: "succeeded" };
        },
      });
    },
  };
  const push = (text: string, isMention = false) =>
    sink?.({
      surfaceId: "fake",
      contextId: "t1",
      author: "U_A",
      text,
      trustLabel: "untrusted",
      isMention,
      messageId: "m1",
    });
  return { plugin, sent, reacted, push };
}

const drain2 = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
};

async function runThread(answer: string, text: string, isMention = false, mode: Mode = "live") {
  const m = judgeModel(answer);
  const s = threadSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push(text, isMention);
  await drain2();
  const tools = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  await agent.destroy();
  return { sent: s.sent, reacted: s.reacted, requests: m.requests, tools };
}

test("人同士の会話には割り込まない", async () => {
  const { sent } = await runThread("no", "B-san の方が詳しいと思う");
  expect(sent).toEqual([]);
});

test("黙ったときは記憶も書かない（会話に参加していないので）", async () => {
  const { tools } = await runThread("no", "B-san の方が詳しいと思う");
  expect(tools).toEqual([]);
});

test("印だけ付ける（stamp）と判断したら、返信せずにリアクションを付ける", async () => {
  // **黙るだけだと、落ちているのか読んで黙っているのかを人が区別できない。**
  // かといって全部に付けると「全部読んでいます」の表明になるので、
  // 自分に関係があるが言葉は要らないときだけ
  const { sent, reacted } = await runThread("stamp", "よろしくね");

  expect(sent).toEqual([]);
  expect(reacted).toEqual(["acknowledged"]);
});

test("黙るときはリアクションも付けない（既読を付けて回らない）", async () => {
  const { reacted } = await runThread("no", "B-san の方が詳しいと思う");
  expect(reacted).toEqual([]);
});

test("dryrun ではリアクションも付けない（外から見える行為なので）", async () => {
  const { reacted } = await runThread("stamp", "よろしくね", false, "dryrun");
  expect(reacted).toEqual([]);
});

test("自分宛と判断したら返す", async () => {
  const { sent } = await runThread("yes", "これ調べてもらえる？");
  expect(sent).toHaveLength(1);
});

test("止まっているときは判定モデルを呼ばない（凍結の判定が先）", async () => {
  // 止めているのに判定モデルだけ動くのは意図と違う。
  // 名指しは決定論で即決するので、凍結中の「止まっています」は従来どおり返せる
  const m = judgeModel("no");
  const s = threadSurface();
  const kill: RussellPlugin = {
    id: "fake-killswitch",
    name: "fake kill switch",
    setup(ctx) {
      ctx.services.provide<KillSwitchCapability>(KILL_SWITCH_SERVICE, {
        async current() {
          return { stopped: true, scope: "agent", by: "owner", at: null, reason: null };
        },
        async stop() {
          throw new Error("未使用");
        },
        async resume() {
          throw new Error("未使用");
        },
      });
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, kill, s.plugin],
  );
  s.push("で、どうする？");
  await drain2();
  await agent.destroy();

  expect(m.requests.some((r) => r.system.includes("口を開くべきか"))).toBe(false);
});

test("判断の記録には、どの発言かまで入る（スレッドだけでは追えない）", async () => {
  const m = judgeModel("no");
  const s = threadSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  const seen: { contextId: string; messageId?: string }[] = [];
  agent.ctx.events.on<{ contextId: string; messageId?: string }>("reply:judged", (p) => {
    seen.push(p);
  });
  s.push("B-san の方が詳しいと思う");
  await drain2();
  await agent.destroy();

  expect(seen).toHaveLength(1);
  expect(seen[0]?.messageId).toBe("m1");
});

test("名指しなら判定そのものを飛ばす（無駄に呼ばない）", async () => {
  const { sent, requests } = await runThread("no", "お願い", true);

  expect(sent).toHaveLength(1);
  expect(requests.some((r) => r.system.includes("口を開くべきか"))).toBe(false);
});

test("複数人の履歴は、誰の発言かを付けてモデルへ渡す", async () => {
  const { requests } = await runThread("yes", "これお願い");
  const conversation = requests.find(
    (r) => !r.system.includes("記憶係") && !r.system.includes("口を開くべきか"),
  );
  expect(JSON.stringify(conversation)).toContain("丸山: これどう？");
});

// --- 気質で返信の長さを変える（verbosity） ---

/** 人格プロンプトを取り出す。会話用の要求（記憶係でも判定でもないもの）に入っている。 */
async function personaOf(verbosity?: Temperament["verbosity"]): Promise<string> {
  const m = judgeModel("yes");
  const s = threadSurface();
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: { ...BOB, ...(verbosity ? { verbosity } : {}) },
      model: "echo",
      mode: "live",
    },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push("これお願い");
  await drain2();
  await agent.destroy();
  return (
    m.requests.find((r) => !r.system.includes("記憶係") && !r.system.includes("口を開くべきか"))
      ?.system ?? ""
  );
}

test("既定は今までどおり（書いていない個体の振る舞いを変えない）", async () => {
  expect(await personaOf()).toContain("普通は3〜5行");
});

test("口数の少ない個体は短く答える", async () => {
  const persona = await personaOf("brief");

  expect(persona).toContain("1〜3行");
  expect(persona).not.toContain("普通は3〜5行");
});

test("詳しく話す個体でも、前置きは増やさない", async () => {
  const persona = await personaOf("detailed");

  expect(persona).toContain("必要なだけ書いてよい");
  // 長さの許可であって、前置きの許可ではない
  expect(persona).toContain("結論から書く");
});
