/**
 * 本棚の編集（§4-3「本棚の編集」）— 重複した本を畳み、見出しを付け直す。
 *
 * なぜ要るか: 記憶をモデルが決めるようになって（ADR 0003）、会話が続くほど**似た本が
 * 積み上がる**ようになった。実際、オンボーディング1回で「役割・情報源」の話が2冊になり、
 * 2冊目が1冊目をほぼ包含していた。本棚は眺めて引くためのものなので、重複はそのまま
 * 索引の劣化になる。
 *
 * ここは**組み立てと検証だけの純関数**。DB とモデルの呼び出しは consolidate.ts が行う。
 *
 * 検証を分けているのは、この経路が **untrusted なテキスト（他者の Slack 発言に由来する本文）を
 * 読んだモデルの出力で DB を書き換える**ため（§12-3）。モデルが返した id をそのまま
 * UPDATE に流さず、実在する・自分の・active な本だけに絞ってから適用する。
 */

/** 整理の対象。DB から読んだ現在の本棚。 */
export interface ShelfBook {
  id: number;
  title: string;
  card: string;
  strength: number;
}

/** 重複を1冊に畳む。`absorb` は消さずに書庫へ下げる（可逆, privacy-and-memory-policy §3 L1）。 */
export interface MergePlan {
  keep: number;
  absorb: number[];
  title: string;
  card: string;
}

/** 内容を言い当てていない見出しを付け直す。 */
export interface RetitlePlan {
  id: number;
  title: string;
}

export interface OrganizePlan {
  merges: MergePlan[];
  retitles: RetitlePlan[];
}

export const EMPTY_PLAN: OrganizePlan = { merges: [], retitles: [] };

/** 見出しとカードの上限。モデルが長文を返しても本棚の見た目を壊さない。 */
const MAX_TITLE = 60;
const MAX_CARD = 600;

const INSTRUCTIONS = `あなたは同僚エージェントの本棚を整理する司書です。本棚の一覧を読み、重複を畳み、見出しを付け直します。

次の JSON だけを出力してください（前後に説明を書かない）:
{"merges": [{"keep": number, "absorb": [number], "title": string, "card": string}], "retitles": [{"id": number, "title": string}]}

- merges: 同じ話題の本をまとめる。keep に残す1冊の id、absorb にまとめられる側の id。
  title と card は**まとめた後の内容**を書く。両方の情報を落とさずに1〜3文で。
- retitles: 見出しが内容を表していない本。id と新しい見出しだけ書く（本文は変えない）。
- どちらも無ければ空配列を返す。

判断の基準:
- **迷ったらまとめない。** 別の話題を1冊にする損失は、2冊のまま残す損失より大きい。
- 話題が同じでも、片方にしか無い具体（日時・担当・数量）があるなら、まとめた card に必ず残す。
- 見出しは20文字前後で、本棚を眺めたときに何の話か分かるように書く。
- 内容の言い換えだけの付け直しはしない。読んで分かるものはそのままにする。`;

/** 本棚の一覧をモデルに渡す形に組み立てる。 */
export function buildOrganizePrompt(books: ShelfBook[]): { system: string; user: string } {
  const list = books.map((b) => `- id=${b.id} 見出し「${b.title}」 内容: ${b.card}`).join("\n");
  return { system: INSTRUCTIONS, user: `本棚（${books.length}冊）:\n${list}` };
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

/**
 * モデルの出力を計画に変換する。**読めなければ「何もしない」に倒す**（fail-safe）。
 *
 * 整理は急ぎの処理ではない。読めない出力で本棚を壊すより、今夜は何もしない方がよい。
 */
export function parseOrganizePlan(text: string): OrganizePlan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return EMPTY_PLAN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return EMPTY_PLAN;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_PLAN;
  const raw = parsed as Record<string, unknown>;

  const merges: MergePlan[] = [];
  for (const item of Array.isArray(raw.merges) ? raw.merges : []) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const keep = asId(m.keep);
    const title = clip(m.title, MAX_TITLE);
    const card = clip(m.card, MAX_CARD);
    const absorb = (Array.isArray(m.absorb) ? m.absorb : [])
      .map(asId)
      .filter((id): id is number => id !== undefined);
    if (keep === undefined || !title || !card || absorb.length === 0) continue;
    merges.push({ keep, absorb, title, card });
  }

  const retitles: RetitlePlan[] = [];
  for (const item of Array.isArray(raw.retitles) ? raw.retitles : []) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = asId(r.id);
    const title = clip(r.title, MAX_TITLE);
    if (id === undefined || !title) continue;
    retitles.push({ id, title });
  }

  return { merges, retitles };
}

/**
 * 計画を**いま本棚にある本だけ**に絞り込む。適用の直前に必ず通す。
 *
 * モデルの出力は untrusted テキストを読んだ結果なので、id を信用しない（§12-3）。
 * 存在しない id、他の個体の本、既に書庫の本、同じ本を2回畳む計画は、ここで落ちる。
 */
export function validatePlan(plan: OrganizePlan, books: ShelfBook[]): OrganizePlan {
  const alive = new Map(books.map((b) => [b.id, b]));
  const claimed = new Set<number>();

  const merges: MergePlan[] = [];
  for (const m of plan.merges) {
    if (!alive.has(m.keep) || claimed.has(m.keep)) continue;
    // 自分自身を吸収しない。重複した id は1回だけ数える。
    const absorb = [...new Set(m.absorb)].filter(
      (id) => id !== m.keep && alive.has(id) && !claimed.has(id),
    );
    if (absorb.length === 0) continue;
    claimed.add(m.keep);
    for (const id of absorb) claimed.add(id);
    merges.push({ ...m, absorb });
  }

  const retitles: RetitlePlan[] = [];
  for (const r of plan.retitles) {
    // 畳む対象の見出しは merge 側が決めるので、二重に触らない。
    if (!alive.has(r.id) || claimed.has(r.id)) continue;
    if (alive.get(r.id)?.title === r.title) continue; // 変わらないなら書かない
    claimed.add(r.id);
    retitles.push(r);
  }

  return { merges, retitles };
}

/** 何かやることがあるか。 */
export function isEmptyPlan(plan: OrganizePlan): boolean {
  return plan.merges.length === 0 && plan.retitles.length === 0;
}
