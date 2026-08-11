/**
 * メモからの昇格（§4-3「週内に3回以上参照されたメモ/スレッドを『本』に昇格」）。
 *
 * なぜ要るか: 会話中に note と shelf を同時に書かせていたら、**両者の粒度が同じ**になった。
 * 同じ1往復を2回要約しているので当然で、「時間の射程が違う」という区別が材料の側に無かった。
 * 本は**複数のメモを横断して**書かれるから一段抽象度が上がる——それが設計の形。
 *
 * ここは組み立てと検証だけの純関数。DB とモデルの呼び出しは consolidate.ts が行う。
 * organize.ts と同じく、**モデルが返した id は信用しない**（§12-3）。
 */

/** 昇格の材料。まだ昇格していない、期間内のメモ。 */
export interface PromotableNote {
  id: number;
  content: string;
}

/** 何冊かのメモを1冊の本にする。 */
export interface PromotionPlan {
  /** 材料にしたメモ。**本棚から会話へ遡るための来歴**でもある。 */
  noteIds: number[];
  title: string;
  card: string;
}

/**
 * 何件のメモに現れたら昇格させるか（§4-3 の「3回以上」）。
 *
 * 下げると本棚が会話の粒度に戻る（それが今回直している問題そのもの）。
 */
export const MIN_NOTES_FOR_PROMOTION = 3;

const MAX_TITLE = 60;
const MAX_CARD = 600;

const INSTRUCTIONS = `あなたは同僚エージェントの司書です。ここ数日のメモを読み、**繰り返し現れる話題**だけを本棚の1冊にまとめます。

次の JSON だけを出力してください（前後に説明を書かない）:
{"promotions": [{"note_ids": [number], "title": string, "card": string}]}

- note_ids: その話題が現れたメモの id。**${MIN_NOTES_FOR_PROMOTION}件以上**でなければ昇格させない。
- title: 本棚を眺めたときに何の話か分かる見出し。20文字前後。
- card: 後々まで効く形にまとめた1〜3文。

判断の基準:
- **1回きりの出来事は昇格させない。** 「今日17時までに返信する」「今日はAさんが休み」は本にならない。
- 昇格させるのは、人・仕事の進め方・繰り返し出てくる事実など、**来月読んでも意味があるもの**。
- メモの言い換えにしない。**複数のメモを通して見えてきたこと**を、一段まとめた形で書く。
- 期限つきの具体（日時・当日の状態・返答待ち）はメモに置いたまま、本には書かない。
- 該当が無ければ promotions は空配列。**迷ったら昇格させない。**`;

/** 昇格の候補をモデルに渡す形に組み立てる。 */
export function buildPromotionPrompt(notes: PromotableNote[]): { system: string; user: string } {
  const list = notes.map((n) => `- id=${n.id}: ${n.content}`).join("\n");
  return { system: INSTRUCTIONS, user: `メモ（${notes.length}件）:\n${list}` };
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  return text.slice(0, max);
}

function asId(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : undefined;
}

/** モデルの出力を読む。**読めなければ昇格しない**に倒す（fail-safe）。 */
export function parsePromotions(text: string): PromotionPlan[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const raw = parsed as Record<string, unknown>;

  const plans: PromotionPlan[] = [];
  for (const item of Array.isArray(raw.promotions) ? raw.promotions : []) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    const title = clip(p.title, MAX_TITLE);
    const card = clip(p.card, MAX_CARD);
    const noteIds = (Array.isArray(p.note_ids) ? p.note_ids : [])
      .map(asId)
      .filter((id): id is number => id !== undefined);
    if (!title || !card || noteIds.length === 0) continue;
    plans.push({ noteIds, title, card });
  }
  return plans;
}

/**
 * 計画を**いま昇格できるメモだけ**に絞る。適用の直前に必ず通す。
 *
 * - 実在しない id・既に昇格済みのメモは落とす（渡した一覧にしか無いものだけ通す）
 * - 同じメモを2冊の材料にしない
 * - `MIN_NOTES_FOR_PROMOTION` 件に満たない話題は昇格させない（**これが粒度の担保**）
 */
export function validatePromotions(
  plans: PromotionPlan[],
  notes: PromotableNote[],
  minNotes = MIN_NOTES_FOR_PROMOTION,
): PromotionPlan[] {
  const available = new Set(notes.map((n) => n.id));
  const used = new Set<number>();
  const valid: PromotionPlan[] = [];

  for (const plan of plans) {
    const noteIds = [...new Set(plan.noteIds)].filter((id) => available.has(id) && !used.has(id));
    if (noteIds.length < minNotes) continue;
    for (const id of noteIds) used.add(id);
    valid.push({ ...plan, noteIds });
  }
  return valid;
}
