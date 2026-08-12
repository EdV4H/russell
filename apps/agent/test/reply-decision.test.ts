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

test("判定は迷ったら no と指示している", () => {
  const req = buildReplyJudgeRequest(ctx({ history: group }));

  expect(req.system).toContain("迷ったら no");
  // 呼ばれてから答える、という方向づけ
  expect(req.system).toContain("呼ばれてから答える");
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

test("読み取りは yes だけを true にする。**読めなければ黙る**", () => {
  expect(parseReplyJudgement("yes")).toBe(true);
  expect(parseReplyJudgement("Yes, あなた宛です")).toBe(true);
  expect(parseReplyJudgement("no")).toBe(false);
  expect(parseReplyJudgement("")).toBe(false);
  // 説明を返してきた場合も、yes で始まらなければ黙る
  expect(parseReplyJudgement("これは丸山さんとA-sanの会話です")).toBe(false);
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
          if (req.system.includes("直前の発言があなたに向けられているか")) return { text: answer };
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
  return { plugin, sent, push };
}

const drain2 = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
};

async function runThread(answer: string, text: string, isMention = false) {
  const m = judgeModel(answer);
  const s = threadSurface();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), m.plugin, s.plugin],
  );
  s.push(text, isMention);
  await drain2();
  const tools = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  await agent.destroy();
  return { sent: s.sent, requests: m.requests, tools };
}

test("人同士の会話には割り込まない", async () => {
  const { sent } = await runThread("no", "B-san の方が詳しいと思う");
  expect(sent).toEqual([]);
});

test("黙ったときは記憶も書かない（会話に参加していないので）", async () => {
  const { tools } = await runThread("no", "B-san の方が詳しいと思う");
  expect(tools).toEqual([]);
});

test("自分宛と判断したら返す", async () => {
  const { sent } = await runThread("yes", "これ調べてもらえる？");
  expect(sent).toHaveLength(1);
});

test("名指しなら判定そのものを飛ばす（無駄に呼ばない）", async () => {
  const { sent, requests } = await runThread("no", "お願い", true);

  expect(sent).toHaveLength(1);
  expect(requests.some((r) => r.system.includes("直前の発言があなたに向けられているか"))).toBe(
    false,
  );
});

test("複数人の履歴は、誰の発言かを付けてモデルへ渡す", async () => {
  const { requests } = await runThread("yes", "これお願い");
  const conversation = requests.find(
    (r) => !r.system.includes("記憶係") && !r.system.includes("向けられているか"),
  );
  expect(JSON.stringify(conversation)).toContain("丸山: これどう？");
});
