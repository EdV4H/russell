/**
 * 積み残しをどこまで遡るか（#124）。
 *
 * 既定は直近12時間。窓を切っているのは「起動のたびに何日も前のスレッドへ返信し始める」のを
 * 防ぐためで、そこは正しい。**ただしその理屈は「基本的に動いている」が前提である。**
 *
 * 実際には長時間止まる。4日間落ちていた間に来た呼びかけは、復帰時には全部窓の外にあり、
 * **一件も拾われなかった**。「古い話を掘り返さない」と「留守にしていた分に応える」は
 * 別のことなのに、同じ窓で切っていたのが原因である。
 *
 * ここは組み立てだけの純関数。前回いつまで動いていたかは呼び出し側が渡す。
 */

/** どこまで遡るかと、その理由。**理由を返すのは、返信の書き方が変わるため。** */
export interface CatchupWindow {
  since: Date;
  /** 留守明けとして広げたか。広げたなら、どれだけ止まっていたか（ミリ秒）。 */
  awayMs?: number;
  /** 上限で頭打ちにしたか。**黙って切り詰めない**ため、呼び出し側へ渡す。 */
  capped: boolean;
}

export interface CatchupWindowInput {
  now: Date;
  /** 通常の窓（既定12時間）。 */
  windowMs: number;
  /** 留守明けに遡ってよい上限。 */
  maxAwayMs: number;
  /** 前回いつまで動いていたか。分からなければ undefined（初回起動・記録が読めない）。 */
  lastSeenAt?: Date;
}

/**
 * 窓を決める。
 *
 * - 前回が分からない、または通常の窓に収まる → **既定のまま**（何も変えない）
 * - 前回が窓より前 → **前回まで遡る**（留守にしていた分に応える）
 * - それが上限を超える → 上限で止め、**止めたことを伝える**
 *
 * 未来の時刻を渡されたら既定に倒す。時計がずれている DB を信じて「これから先の分を拾う」
 * のは意味が無く、そのまま計算すると窓が負になって全部拾ってしまう。
 */
export function catchupWindow(input: CatchupWindowInput): CatchupWindow {
  const normal = new Date(input.now.getTime() - input.windowMs);
  const last = input.lastSeenAt;
  if (!last || Number.isNaN(last.getTime()) || last.getTime() >= input.now.getTime()) {
    return { since: normal, capped: false };
  }
  // 通常の窓に収まっている＝留守にしていない（普段の再起動はここ）
  if (last.getTime() >= normal.getTime()) return { since: normal, capped: false };

  const awayMs = input.now.getTime() - last.getTime();
  const limit = new Date(input.now.getTime() - input.maxAwayMs);
  if (last.getTime() < limit.getTime()) {
    return { since: limit, awayMs, capped: true };
  }
  return { since: last, awayMs, capped: false };
}

/** 留守の長さを人が読む形にする。ログと監査に出す（本文は出さない, A1-5）。 */
export function describeAway(awayMs: number): string {
  const hours = Math.round(awayMs / (60 * 60 * 1000));
  if (hours < 48) return `${hours}時間`;
  return `${Math.round(hours / 24)}日`;
}
