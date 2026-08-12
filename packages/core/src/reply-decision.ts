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
 * - 名指し（mention / DM）→ 返す
 * - 本文に自分の名前 → 返す（`@` を付けずに「Bob どう思う?」と書く人は多い）
 * - **相手が1人だけのスレッド** → 返す。宛先が自明なので judgment は要らない
 * - それ以外（3人以上で、名指しでもない）→ **曖昧**。モデルに聞く
 */
export function decideReply(ctx: ReplyContext): ReplyVerdict {
  if (ctx.isMention) return { reply: true, reason: "mentioned" };

  const name = ctx.selfName.trim().toLowerCase();
  if (name.length >= 2 && ctx.text.toLowerCase().includes(name)) {
    return { reply: true, reason: "named" };
  }

  const speakers = new Set(
    ctx.history.filter((t) => t.role === "user").map((t) => t.speaker ?? "?"),
  );
  // 相手が1人（または誰も分からない）なら、宛先は自分しかいない
  if (speakers.size <= 1) return { reply: true, reason: "one_on_one" };

  return { reply: false, reason: "ask_model" };
}

const JUDGE = `あなたは会話の同席者です。**直前の発言があなたに向けられているか**だけを判断します。

"yes" か "no" だけを出力してください。説明は書かないこと。

- yes: あなたに聞いている、あなたの担当の話、あなたが答えないと止まる
- no: 他の人同士のやりとり、あなたが入る必要のない相づちや雑談

**迷ったら no。** 呼ばれていないのに割り込むより、呼ばれてから答える方がよい。
本当に用があるなら、相手はあなたの名前を呼びます。`;

/** 曖昧なときにモデルへ渡す要求。**短く保つ**——これは会話ではなく判定なので。 */
export function buildReplyJudgeRequest(ctx: ReplyContext): { system: string; user: string } {
  const recent = ctx.history
    .slice(-6)
    .map((t) => `${t.role === "assistant" ? ctx.selfName : (t.speaker ?? "誰か")}: ${t.text}`)
    .join("\n");
  return {
    system: `${JUDGE}\n\nあなたの名前: ${ctx.selfName}`,
    user: `${recent}\n\n--- 直前の発言 ---\n${ctx.text}`,
  };
}

/** 判定の読み取り。**読めなければ黙る**（割り込むより黙る方が害が小さい）。 */
export function parseReplyJudgement(text: string): boolean {
  return /^\s*(yes|はい)\b/i.test(text.trim());
}
