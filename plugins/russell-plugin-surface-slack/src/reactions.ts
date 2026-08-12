/**
 * どの絵文字で表すかを決める。**ここは通信面の裁量**（§10.1）。
 *
 * コアが渡すのは意味だけ（`noted` / `acknowledged`）で、絵文字は知らない。
 * 同じ「読みました」でも、歓迎の言葉に 👀 を返すのと 👋 を返すのでは受け取られ方が違う——
 * その差は Slack という場の話なので、コアではなくここで決める。
 *
 * **決定論の表で書く。** モデルに選ばせると、リアクション1つのために待ち時間と費用が乗り、
 * 外れたときに理由も追えない。ここは外しても実害が小さい代わりに、頻度が高い。
 */

import type { ReactionKind } from "@edv4h/russell-shared";

/**
 * 意味ごとの既定。**標準の絵文字名だけを使う**——カスタム絵文字はワークスペースによって
 * 有無が違い、無い名前を送ると Slack が `invalid_name` で弾く。ここは最後の逃げ道なので確実に存在させる。
 */
const DEFAULT_EMOJI: Record<ReactionKind, string> = {
  noted: "memo", // 📝 書き留めた
  acknowledged: "eyes", // 👀 読んだ
};

interface Rule {
  pattern: RegExp;
  emoji: string;
}

/**
 * 文面から選ぶ規則。**上から順に、最初に当たったもの**。
 *
 * 効かせるのは `acknowledged`（読んだ印）だけ。`noted` は「自分が何をしたか」の表明で、
 * 相手の文面で変わるものではない。
 */
const RULES: Rule[] = [
  // 感謝。「ありがとうございます」に 👀 を返すのはそっけない
  { pattern: /(ありがと|感謝|助かり|助かる|thanks|thank you)/i, emoji: "pray" }, // 🙏
  // 祝い
  { pattern: /(おめでと|リリース(した|しました|完了)|達成|やった[ー！!]|congrat)/i, emoji: "tada" }, // 🎉
  // ねぎらい
  { pattern: /(お疲れ|おつかれ|ご苦労)/, emoji: "tea" }, // 🍵
  // 歓迎・挨拶。新しく入った側への「よろしく」はここ
  {
    pattern: /(よろしく|歓迎|ようこそ|初日|はじめまして|お待ちして)/,
    emoji: "wave", // 👋
  },
  // 励まし
  { pattern: /(頑張|がんば|期待して|楽しみ|応援)/, emoji: "muscle" }, // 💪
  // 依頼・合意。頷けば済むもの
  { pattern: /(お願いします|了解|承知|OK|オッケー|大丈夫)/i, emoji: "+1" }, // 👍
];

/**
 * 意味と（分かれば）文面から絵文字を選ぶ。
 *
 * 文面が分からないときは既定を返す。**当てにいかない**——再起動後や積み残しの確認では
 * 元の文が手元に無いことがあり、そこで外した絵文字を付けるより 👀 の方がよい。
 */
export function pickReactionEmoji(kind: ReactionKind, text?: string): string {
  if (kind !== "acknowledged" || !text) return DEFAULT_EMOJI[kind];
  const hit = RULES.find((r) => r.pattern.test(text));
  return hit ? hit.emoji : DEFAULT_EMOJI[kind];
}

/** 選んだ名前が使えなかったときの逃げ道。**必ず存在する標準の名前**。 */
export function defaultReactionEmoji(kind: ReactionKind): string {
  return DEFAULT_EMOJI[kind];
}

/**
 * 発言の本文を、リアクションを付けるときまで覚えておく入れ物。
 *
 * `react()` が受け取るのは id だけ（意味と宛先しか渡さないのがコアとの契約）なので、
 * 文面はこちら側で控える。**取りに行かない**——絵文字1つのために API を1回叩くのは割に合わない。
 *
 * 上限を切ってあるのは、常駐プロセスで際限なく溜めないため。溢れたら古い順に捨てる
 * （リアクションは受信直後に付くので、古いものは要らない）。
 */
export function createTextMemo(limit = 200) {
  const texts = new Map<string, string>();
  return {
    remember(messageId: string | undefined, text: string): void {
      if (!messageId) return;
      texts.set(messageId, text);
      if (texts.size > limit) {
        const oldest = texts.keys().next();
        if (!oldest.done) texts.delete(oldest.value);
      }
    },
    get(messageId: string): string | undefined {
      return texts.get(messageId);
    },
    get size(): number {
      return texts.size;
    },
  };
}
