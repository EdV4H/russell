/**
 * 返すかどうかの判断（グループのスレッド対策）。
 *
 * これまでは「参加しているスレッドの続きは全部自分への発話」として扱っていた。1対1では
 * 自然だが、**3人以上のスレッドでは人同士の会話にも全部返信する**——実際に鬱陶しいと言われた。
 *
 * **拾うか（追従するか）と、返すか（自分宛か）は別の判断**である。前者は通信面が決め
 * （Slack のスレッド構造の話）、後者はここが決める。
 *
 * 判断は2段階にしてある。**大半は決定論で即決**し、本当に曖昧なときだけモデルに聞く——
 * 毎回モデルを呼ぶと、人同士の雑談1つごとに待ち時間と費用が乗る。
 */

import type { ModelTurn } from "@edv4h/russell-shared";

export interface ReplyContext {
  /** 明示的に名指しされたか（mention / DM）。 */
  isMention: boolean;
  text: string;
  /**
   * **いま届いた発言の発言者。**
   *
   * 履歴には入っていない（コアが `user` として別に渡すので重複を外している）。
   * ここを数えないと、**3人目が入ってきた最初の1回**が「相手は1人」に見えて素通りする。
   */
  speaker?: string;
  /** 自分の名前（本文に出てきたら呼ばれたとみなす）。 */
  selfName: string;
  /** 直近のやりとり。**発言者が入っている**ことが効く。 */
  history: ModelTurn[];
}

export type ReplyVerdict =
  | { reply: true; reason: "mentioned" | "named" | "one_on_one" | "no_judge" }
  | { reply: false; reason: "ask_model" };

/**
 * 決定論で決まる分だけ決める。**決まらなければモデルに聞く**（`ask_model`）。
 *
 * - 名指し（mention / DM）→ 返す。**ここは聞かない**——直接聞かれたのに黙るのは、
 *   余計に喋るより悪い失敗で、判定を挟むと返信までの時間だけが伸びる
 * - **相手が1人だけ** → 返す。宛先が自明
 *   （本文に自分の名前が出ていれば `named`、無ければ `one_on_one`。扱いは同じ）
 * - それ以外（3人以上）→ **曖昧**。モデルに聞く
 *
 * 本文の名前で即決するのは**1対1のときだけ**。3人以上では「Bob に聞いてみたら？」のように
 * **自分について話しているだけ**の発言が普通に出るので、名前が出た＝自分宛にはならない。
 */
export function decideReply(ctx: ReplyContext): ReplyVerdict {
  if (ctx.isMention) return { reply: true, reason: "mentioned" };

  const speakers = new Set(
    ctx.history.filter((t) => t.role === "user").map((t) => t.speaker ?? "?"),
  );
  // **いまの発言者も数える。** 履歴だけで数えると、3人目の初回発言が「1対1」に見える
  if (ctx.speaker) speakers.add(ctx.speaker);

  // 相手が1人（または誰も分からない）なら、宛先は自分しかいない
  if (speakers.size <= 1) {
    const name = ctx.selfName.trim().toLowerCase();
    const named = name.length >= 2 && ctx.text.toLowerCase().includes(name);
    return { reply: true, reason: named ? "named" : "one_on_one" };
  }

  return { reply: false, reason: "ask_model" };
}

/**
 * 判定の指示。
 *
 * 最初は「**宛先が自分か**」だけを聞き、締めを「**迷ったら no**」にしていた。
 * 実測すると、**自分の話をされているのに黙る**（`reply-judge-eval.test.ts` で 3/3 黙った）。
 * 「この子、休憩も休日も無いらしい」のように三人称で本人のことを話す発言に反応せず、
 * 「分からないことがあったら聞いてね」という呼びかけにも反応しなかった。
 * 同席している同僚としては不自然である。
 *
 * yes の条件を足すだけでは動かなかった。**締めの一言が全部を持っていく**ので、
 * 判断の軸そのものを「宛先か」から「**その発言に自分が出てくるか**」へ変えてある。
 * 割り込まない性質は「自分が出てこないなら no」で保つ——鬱陶しかったのは
 * 「自分が出てこない、人同士の実務のやりとり」に入っていくことだった。
 */
const JUDGE = `あなたは会話の同席者です。**直前の発言に、あなたが口を開くべきか**を判断します。

"yes" か "no" だけを出力してください。説明は書かないこと。

見るのは1点だけ: **その発言に「あなた」が出てくるか。**

- yes: あなたに聞いている・頼んでいる。あなたの担当の話。あなたが答えないと止まる
- yes: あなたに向けた呼びかけ（名前が無くても、その場で新しく入ったのがあなたなら
  「よろしく」「困ったら聞いてね」はあなた宛です）
- yes: **あなたのことを話している。** 三人称（「この子」「新しく入った人」）でも、
  名前が出ていなくても、流れで自分のことだと分かるなら yes。
  あなたをネタにした冗談も yes——自分の話で笑っているのに黙っている方が不自然です
- no: **あなたが出てこない**、人同士のやりとり。相づち・雑談・他の人への依頼や質問

**人同士の会話であっても、あなたの話をしているなら yes です。**
判断は「誰が話しているか」ではなく「**あなたが出てくるか**」で決めてください。

**自分が出てこないなら no。** 人同士の話に呼ばれてもいないのに入るのは、鬱陶しいだけです。`;

/** 曖昧なときにモデルへ渡す要求。**短く保つ**——これは会話ではなく判定なので。 */
export function buildReplyJudgeRequest(ctx: ReplyContext): { system: string; user: string } {
  const recent = ctx.history
    .slice(-6)
    .map((t) => `${t.role === "assistant" ? ctx.selfName : (t.speaker ?? "誰か")}: ${t.text}`)
    .join("\n");
  return {
    system: `${JUDGE}\n\nあなたの名前: ${ctx.selfName}`,
    user: `${recent}\n\n--- 直前の発言 ---\n${ctx.speaker ? `${ctx.speaker}: ` : ""}${ctx.text}`,
  };
}

/** 判定の読み取り。**読めなければ黙る**（割り込むより黙る方が害が小さい）。 */
export function parseReplyJudgement(text: string): boolean {
  return /^\s*(yes|はい)\b/i.test(text.trim());
}
