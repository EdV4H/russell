/**
 * 日記の文章を書く（§4-1）。
 *
 * これまでは決定論的な連結だった（「13件の記録。メモA / メモB / …」）。実際に流したら
 * 3743字の羅列になり、**読み物として成立していなかった**。日記はエピソード記憶で、
 * 毎朝チャンネルに投稿される前提（§10.1）なので、読まれない日報には意味がない。
 *
 * ここは組み立てだけの純関数。モデル呼び出しは consolidate.ts が行う。
 *
 * **日記は公開される。** だから DO-NOT-WRITE を渡す側（呼び出し元）が持っていて、
 * 生成後にもう一度ガードを通す（一次＝プロンプト、二次＝決定論フィルタ, A-1 §0）。
 */

/** 日記に渡す材料。機微情報の印が付いたメモは**呼び出し側で既に除いてある**。 */
export interface JournalMaterial {
  entryDate: string;
  agentName: string;
  notes: string[];
}

/** 目安の長さ。長すぎると読まれず、短すぎると日記にならない。 */
const TARGET_CHARS = "300〜600字";

/**
 * 日記を書かせる要求を組み立てる。
 *
 * 「まとめて」ではなく「**その日を振り返って書く**」と言うのが要点。要約を頼むと
 * 箇条書きの圧縮が返ってきて、連結していた頃と変わらない。
 */
export function buildJournalRequest(
  material: JournalMaterial,
  doNotWrite: string,
): { system: string; user: string } {
  const system = `あなたは「${material.agentName}」という同僚エージェントです。一日の終わりに日記を書きます。

- **その日を振り返って書く。** 箇条書きの要約ではなく、地の文で書く。
- 一人称。同僚として実際に何をして、何が分かって、何が分からなかったかを書く。
- **分からなかったこと・確認待ちのことを省かない。** それも一日の事実。
- 推測を事実として書かない。曖昧なことは曖昧なまま書く。
- ${TARGET_CHARS}程度。日付や見出しは書かず、本文だけを返す。

この日記は毎朝チームのチャンネルに投稿されます。
${doNotWrite}`;

  const user = `${material.entryDate} のメモ（${material.notes.length}件）です。これを材料にして日記を書いてください。

${material.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;

  return { system, user };
}

/** 生成された日記が使えるか。空・短すぎ・JSON っぽいものは採らない。 */
export function usableNarrative(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}
