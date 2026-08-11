/**
 * 単語帳の照合（索引カード, ADR 0008）。
 *
 * **モデルを使わない。** 別名は文字列なので、受信テキストとの一致で引ける。
 * 設計書 §3.2 はエンティティ抽出に Haiku を想定しているが、単語帳に関しては
 * 照合で足りる——そしてモデルを挟まなければ、想起は**レイテンシを1ミリ秒も増やさない**。
 *
 * 純関数にしてあるのは、誤爆（短い別名が別の語の一部に当たる）をテストで固めたいため。
 */

import type { RecalledTerm } from "@edv4h/russell-shared";

/** キャッシュの寿命。書き込み時に無効化するので、これは保険。 */
export const TERM_CACHE_MS = 60_000;

/** 1回の想起に載せる上限。文脈予算（§3.2, ~3,000トークン）を単語帳で埋めない。 */
export const MAX_INJECTED_TERMS = 5;

/**
 * 短すぎる別名は照合に使わない。
 *
 * 1文字の別名（「A」など）は日本語の文中でほぼ必ず当たる。**誤爆した用語を注入するのは、
 * 何も注入しないより悪い**（関係ない定義を前提に答え始める）ので、拾わない側へ倒す。
 */
const MIN_ALIAS_LENGTH = 2;

export interface StoredTerm {
  name: string;
  summary: string;
  aliases: string[];
}

/**
 * テキストに出てくる用語を返す。**長い一致を優先**する。
 *
 * 「MQL」と「MQL目標」が両方登録されているとき、後者が本文にあるなら後者を選びたい。
 * 短い方も当たるが、より具体的な方が役に立つ。
 */
export function matchTerms(text: string, terms: StoredTerm[]): RecalledTerm[] {
  const haystack = text.toLowerCase();
  const hits: { term: StoredTerm; length: number }[] = [];

  for (const term of terms) {
    let best = 0;
    for (const candidate of [term.name, ...term.aliases]) {
      const needle = candidate.trim().toLowerCase();
      if (needle.length < MIN_ALIAS_LENGTH) continue;
      if (!haystack.includes(needle)) continue;
      best = Math.max(best, needle.length);
    }
    if (best > 0) hits.push({ term, length: best });
  }

  return hits
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_INJECTED_TERMS)
    .map((h) => ({ name: h.term.name, definition: h.term.summary }));
}
