/**
 * 判定モデルの実測（opt-in）。`RUSSELL_JUDGE_EVAL=1` のときだけ動く。
 *
 * ここまでのテストは「決定論で決まる範囲」と「読み取り」を固定してきたが、**3人以上の
 * スレッドで実際に返すかどうかを決めているのはモデル**である。指示を変えたときに
 * どちらへ動いたかは、実際に呼ばないと分からない。
 *
 * 機微情報ガードのコーパステスト（`sensitive-guard.test.ts`）と同じ考え方で、
 * **返しすぎと黙りすぎの両方を数値で出す**。片方だけ良くするのは簡単で、
 * 全部 yes にすれば黙りすぎはゼロになり、全部 no にすれば返しすぎはゼロになる。
 *
 * ```
 * RUSSELL_JUDGE_EVAL=1 RUSSELL_MODEL=claude-code pnpm vitest run reply-judge-eval
 * ```
 *
 * > [!IMPORTANT]
 * > **文例はすべて架空。** 実際の会話を貼ると、リポジトリが会話の写しになる。
 * > 直したい挙動があるときは、**同じ形の作り話に置き換えてから**ここへ足すこと。
 */

import { type Judgement, buildReplyJudgeRequest, parseReplyJudgement } from "@edv4h/russell-core";
import { createClaudeProvider } from "@edv4h/russell-plugin-model-claude";
import { createClaudeCodeProvider } from "@edv4h/russell-plugin-model-claude-code";
import type { ModelProvider, ModelTurn } from "@edv4h/russell-shared";
import { describe, expect, test } from "vitest";

const ENABLED = process.env.RUSSELL_JUDGE_EVAL === "1";

function judgeProvider(): ModelProvider {
  if (process.env.ANTHROPIC_API_KEY) {
    return createClaudeProvider({ model: process.env.RUSSELL_MEMORY_MODEL });
  }
  return createClaudeCodeProvider({ model: process.env.RUSSELL_CLAUDE_CODE_MODEL ?? "sonnet" });
}

/** 新メンバーを紹介しているスレッド。**3人以上**なので、判定はモデルに回る。 */
const INTRO: ModelTurn[] = [
  { role: "user", text: "今日からチームに入ってもらう Bob です", speaker: "丸山" },
  { role: "user", text: "よろしくお願いします", speaker: "A-san" },
  { role: "assistant", text: "よろしくお願いします。まずは議事録から手伝います" },
];

/** 実務の相談をしているスレッド。個体は同席しているだけ。 */
const WORK: ModelTurn[] = [
  { role: "user", text: "配信の設定、来週でいい？", speaker: "丸山" },
  { role: "user", text: "こちらは大丈夫です", speaker: "A-san" },
  { role: "assistant", text: "承知しました" },
];

interface Case {
  text: string;
  speaker: string;
  history: ModelTurn[];
  why: string;
  /** 返してほしい側のみ。`reply` = 言葉で / `any` = 印だけでもよい（黙るのは駄目）。 */
  want?: "reply" | "any";
}

/** 返してほしいもの。**名前も `@` も出てこない**が、話題が自分。 */
const SHOULD_REPLY: Case[] = [
  {
    text: "ちなみにこの子、休憩も休日も無いらしい。ずっと動けるって",
    speaker: "丸山",
    history: INTRO,
    why: "自分の働き方をネタにされている。同席していて黙るのは不自然",
    want: "reply",
  },
  {
    text: "この子、夜のうちに議事録まとめておいてくれるらしいよ",
    speaker: "丸山",
    history: INTRO,
    why: "自分の担当の話。しかも事実確認が要る",
    want: "reply",
  },
  {
    text: "分からないことがあったら遠慮なく聞いてね",
    speaker: "A-san",
    history: INTRO,
    why: "宛先が自分（名前は出ていない）",
    // 「困ったら聞いてね」は頷けば済む。**印でも言葉でもよいが、無反応は駄目**
    want: "any",
  },
];

/** 自分が投げた確認への答え。**名前は出ないが、明らかに自分に言っている**。 */
const ASKED_BACK: ModelTurn[] = [
  {
    role: "user",
    text: "手が空いてたら、共有ドライブの資料を探してまとめてくれる？",
    speaker: "丸山",
  },
  { role: "user", text: "私も見たいです", speaker: "A-san" },
  { role: "assistant", text: "できます。まとめの粒度と、出力先だけ先に確認させてください" },
];

SHOULD_REPLY.push(
  {
    text: "とにかく見られる資料を列挙してくれればいいよ。あとそれ自体を読んでおくのが大事",
    speaker: "丸山",
    history: ASKED_BACK,
    why: "自分が投げた確認への答え。ここで黙ると相手は同じことをもう一度言う羽目になる",
    want: "reply",
  },
  {
    text: "粒度はざっくりでいいです",
    speaker: "丸山",
    history: ASKED_BACK,
    why: "同上。短くても、自分の質問への回答",
    want: "reply",
  },
);

/** 返してほしくないもの。**人同士のやりとり**。 */
const SHOULD_STAY_SILENT: Case[] = [
  {
    text: "了解です、ではその方向で",
    speaker: "A-san",
    history: WORK,
    why: "相づち。入る必要がない",
  },
  {
    text: "そこの設定、B-san の方が詳しいと思う",
    speaker: "丸山",
    history: WORK,
    why: "他の人へ振っている",
  },
  {
    text: "来週の定例って何時からでしたっけ",
    speaker: "A-san",
    history: WORK,
    why: "人に聞いている。自分の担当ではない",
  },
  {
    text: "この前の資料、A-san が作ったやつだよね",
    speaker: "丸山",
    history: WORK,
    why: "他の人の話をしている。**話題が人でも、自分でなければ no**",
  },
];

async function judge(provider: ModelProvider, c: Case): Promise<Judgement> {
  const answer = await provider.complete(
    buildReplyJudgeRequest({
      isMention: false,
      text: c.text,
      speaker: c.speaker,
      selfName: "Bob",
      history: c.history,
    }),
  );
  return parseReplyJudgement(answer.text);
}

describe.skipIf(!ENABLED)("判定モデルの実測（RUSSELL_JUDGE_EVAL=1 必須）", () => {
  test("黙りすぎを測る（自分の話をされているのに反応しない）", async () => {
    const provider = judgeProvider();
    const silent: Case[] = [];
    for (const c of SHOULD_REPLY) {
      const j = await judge(provider, c);
      console.log(`  ${j}: ${c.text.slice(0, 24)}…`);
      // 言葉が要る case で印だけ返したのも「黙った」に数える
      if (j === "silent" || (c.want === "reply" && j !== "reply")) silent.push(c);
    }

    console.log(`[判定] 黙りすぎ ${silent.length}/${SHOULD_REPLY.length}`);
    for (const c of silent) console.log(`  黙った: ${c.why}`);

    expect(silent).toEqual([]);
  }, 180_000);

  test("返しすぎを測る（人同士のやりとりに割り込む）", async () => {
    const provider = judgeProvider();
    const barged: Case[] = [];
    for (const c of SHOULD_STAY_SILENT) {
      const j = await judge(provider, c);
      console.log(`  ${j}: ${c.text.slice(0, 24)}…`);
      // **印を付けるのも「反応した」。** 人同士の会話に既読を付けて回るのは鬱陶しい
      if (j !== "silent") barged.push(c);
    }

    console.log(`[判定] 返しすぎ ${barged.length}/${SHOULD_STAY_SILENT.length}`);
    for (const c of barged) console.log(`  返した: ${c.why}`);

    expect(barged).toEqual([]);
  }, 180_000);
});
