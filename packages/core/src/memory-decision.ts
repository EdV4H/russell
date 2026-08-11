/**
 * 何を記憶するかをモデルに決めさせる（§3.3 / P0-3・P0-4）。
 *
 * 従来は正規表現で「覚えて」「メモして」「忘れて」を拾っていた。3つの問題があった:
 * - **精度**: 「メモしなくていい」でメモを取る。P0-3（妥当率 ≥90%）/ P0-4（過剰 ≤10%）に届かない
 * - **言語**: 日本語以外は黙って無反応。"remember this" で何も起きない
 * - **明示依存**: 言われないと何も残らない。実際、丸一日会話して本1冊・メモ0件だった
 *
 * **判定はターンの後ろで行う。** 前に置くとモデル呼び出しが2回に増え、応答レイテンシ
 * （P0-1: p95 ≤ 8s）を返答前に使い切る。人間も、答えてから手帳に書く。
 *
 * ここは組み立てと解釈だけの純関数。モデル呼び出しは呼び出し側（create-agent）が行う。
 */

import type { ModelRequest } from "@edv4h/russell-shared";
import { DO_NOT_WRITE_PROMPT } from "./sensitive-guard.js";

/** モデルに決めさせる内容。**それぞれ「無し」が既定**で、迷ったら書かない側に倒す。 */
export interface MemoryDecision {
  /** この文脈の作業メモ（メモ帳）。短期的に効くもの。 */
  note?: string;
  /**
   * 後々まで効く知識（本棚）。読書カードとして1〜2文。
   *
   * **明示的に頼まれたときだけ埋まる。** 言われずに効く知識は、夜間バッチが複数のメモから
   * 昇格させる（ADR 0005）。会話の1往復から直接書くと、メモと粒度が同じ本ができてしまう。
   */
  shelf?: string;
  /** 本棚に載せるときの見出し。索引として読むのはこちらなので、要約であって切り出しではない。 */
  shelfTitle?: string;
  /** 忘れる対象を指す語。本棚の検索に使う。 */
  forget?: string;
}

const INSTRUCTIONS = `あなたは同僚エージェントの記憶係です。直前のやりとりを読み、何を書き留めるべきかだけを決めます。会話への返答はしません。

次の JSON だけを出力してください（前後に説明を書かない）:
{"note": string|null, "shelf": string|null, "title": string|null, "forget": string|null}

- note: このスレッドの作業メモ。数日で価値が消える具体（日時・数量・担当・決まったこと）。
- shelf: **相手が「覚えておいて」と明示的に求めたときだけ**書く。それ以外は null。
  言われなくても効く知識は、後で夜間バッチがメモから昇格させるので、ここで書かなくてよい。
- title: shelf の見出し。**本棚を眺めたときに何の話か分かる**ように、20文字前後で内容を言い当てる。
  文の先頭を切り出したものにしない。shelf が null なら null。
- forget: 相手が忘れるよう求めた対象を指す語。求められていなければ null。

判断の基準:
- **迷ったら null。** 書き留めないことによる損失は小さく、雑音で埋まる損失は大きい。
- 挨拶・相づち・その場で完結する質問は何も残さない。
- 相手が「覚えて」「メモして」と明示したら、その内容を必ず書き留める（shelf にも載せる）。
- あなた（同僚）が「覚えておきます」と答えていたら、その約束を守れるように書き留める。
- 否定（「覚えなくていい」「忘れないで」）を取り違えない。「忘れないで」は forget ではない。
- 言語は問わない。どの言語のやりとりでも同じ基準で判断する。
- **基本は note だけ**。shelf が埋まるのは明示的に頼まれた時に限られる。

${DO_NOT_WRITE_PROMPT}`;

/** 判定用のモデル要求を組み立てる。会話用とは別プロンプトで、履歴は渡さない（直前の1往復で足りる）。 */
export function buildDecisionRequest(userText: string, assistantText: string): ModelRequest {
  return {
    system: INSTRUCTIONS,
    user: `相手: ${userText}\n同僚: ${assistantText}`,
  };
}

/** 空白だけ・記号だけの「書いたつもり」を弾く。 */
function meaningful(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "" || text === "null" || text === "-") return undefined;
  return text;
}

/**
 * モデルの出力を読む。**読めなければ「何も記憶しない」に倒す**（fail-safe）。
 *
 * ここで throw すると、記憶係の不調が会話そのものを壊す。書き留められない方が、
 * 返事が返らないより軽い。
 */
export function parseDecision(text: string): MemoryDecision {
  // ```json フェンスで囲って返すモデルがあるので、最初の { から最後の } までを取る。
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const raw = parsed as Record<string, unknown>;
  const decision: MemoryDecision = {};
  const note = meaningful(raw.note);
  const shelf = meaningful(raw.shelf);
  const title = meaningful(raw.title);
  const forget = meaningful(raw.forget);
  if (note) decision.note = note;
  if (shelf) decision.shelf = shelf;
  // 見出しだけ来ても意味がない（載せる本が無い）。本があるときだけ拾う。
  if (shelf && title) decision.shelfTitle = title;
  if (forget) decision.forget = forget;
  return decision;
}

/** 何か書き留めることがあるか。 */
export function isEmptyDecision(decision: MemoryDecision): boolean {
  return !decision.note && !decision.shelf && !decision.forget;
}
