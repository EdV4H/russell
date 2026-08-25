/**
 * 字幕の見え方を、発言の並びに直す（#130）。
 *
 * Meet の字幕は**書き換わりながら伸びる**。喋っている最中は同じ枠の文字が増えていき、
 * 聞き取り直しが起きれば途中が書き換わる。これをそのまま拾うと、1つの発言が
 * 何十行にもなる。
 *
 * > [!IMPORTANT]
 * > **ここは実際の会議を見るまで正しいと言えない。** 字幕がどう更新されるかは
 * > Meet の実装であって、こちらの仕様ではない。だから2つ用意してある:
 * >
 * > - 判断の規則をこの純関数に閉じ込める（直すときにここだけ直せばよい）
 * > - 生の見え方をそのまま出せるようにする（`RUSSELL_MEET_DEBUG=1`）
 * >
 * > 想像で書いた規則を「動いている」と言わないこと。最初の会議で必ず突き合わせる。
 */

import type { TranscriptLine } from "@edv4h/russell-plugin-meeting";

/** 画面に見えている字幕1枠ぶん。 */
export interface CaptionEntry {
  speaker: string;
  text: string;
}

/**
 * 発言が固まったとみなすまでの静止時間。
 *
 * 短すぎると喋っている途中で切れて細切れになり、長すぎると会議中に使えない
 * （**リアルタイムのために参加している**ので、ここが効く）。
 */
export const SETTLE_MS = 2000;

interface Utterance {
  text: string;
  changedAt: number;
}

export interface CaptionState {
  /** いま喋っている人ごとの、固まっていない発言。 */
  active: Map<string, Utterance>;
  /** 直前に確定した発言。**同じものを二度出さない**ための控え。 */
  settled: Map<string, string>;
}

export function createCaptionState(): CaptionState {
  return { active: new Map(), settled: new Map() };
}

/** 前に出したものの続きか（言い直しではなく、伸びただけか）。 */
function continues(previous: string, next: string): boolean {
  return next.length > previous.length && next.startsWith(previous);
}

/**
 * 見えているものを取り込み、**固まった発言だけ**を返す。
 *
 * 規則は3つ:
 *
 * - 文字が増えている / 書き換わった → まだ喋っている（出さない）
 * - `SETTLE_MS` 変わらない → 固まった（出す）
 * - 画面から消えた → 固まった（出す）。字幕は流れていくので、**消えるのが終わりの合図**
 *
 * 確定した後に同じ人の枠が伸びたら、**続きだけを出す**。全文を出し直すと、
 * 同じ言葉が記憶に二重に入る。
 */
export function ingestCaptions(
  state: CaptionState,
  visible: CaptionEntry[],
  now: number,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const seen = new Set<string>();

  for (const entry of visible) {
    const speaker = entry.speaker.trim();
    const text = entry.text.trim();
    if (speaker === "" || text === "") continue;
    seen.add(speaker);

    // 確定済みの続きなら、**増えた分だけ**を新しい発言として扱う
    const done = state.settled.get(speaker);
    const fresh = done && continues(done, text) ? text.slice(done.length).trim() : text;
    if (done && !continues(done, text) && done === text) continue; // 消え残り。何もしない
    if (fresh === "") continue;

    const active = state.active.get(speaker);
    if (!active) {
      state.active.set(speaker, { text: fresh, changedAt: now });
      continue;
    }
    if (active.text !== fresh) {
      // 伸びた・言い直された。**どちらもまだ喋っている**
      state.active.set(speaker, { text: fresh, changedAt: now });
      continue;
    }
    if (now - active.changedAt >= SETTLE_MS) {
      lines.push({ speaker, text: fresh, at: new Date(now).toISOString() });
      state.active.delete(speaker);
      state.settled.set(speaker, done ? `${done}${fresh}` : fresh);
    }
  }

  // 画面から消えた枠は、そこで終わったということ
  for (const [speaker, active] of [...state.active]) {
    if (seen.has(speaker)) continue;
    lines.push({ speaker, text: active.text, at: new Date(now).toISOString() });
    state.active.delete(speaker);
    const done = state.settled.get(speaker);
    state.settled.set(speaker, done ? `${done}${active.text}` : active.text);
  }

  return lines;
}

/**
 * 溜まったまま残っている発言を出し切る（会議から出るとき）。
 *
 * **言い終わる前に出ることがある。** 固まるのを待っている分を捨てると、
 * 最後の発言——たいてい「では次回」のような決めの一言——が消える。
 */
export function drainCaptions(state: CaptionState, now: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const [speaker, active] of state.active) {
    lines.push({ speaker, text: active.text, at: new Date(now).toISOString() });
  }
  state.active.clear();
  return lines;
}

/**
 * 自分に向けられた発言か。**会議中に応えるかどうかの入口**になる。
 *
 * 名前だけを見る。会議では「Bob、それ調べられる？」のように**呼びかけてから頼む**ので、
 * 名前が出てこない発言に割り込むと、聞いているだけのつもりの人を驚かせる。
 */
export function addressesMe(text: string, name: string): boolean {
  const target = name.trim().toLowerCase();
  if (target === "") return false;
  return text.toLowerCase().includes(target);
}
