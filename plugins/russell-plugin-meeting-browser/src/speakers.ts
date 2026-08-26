/**
 * 「何を言ったか」と「誰が言ったか」を突き合わせる（#130・音声経路）。
 *
 * 字幕は誰が言ったかを**無料で**くれるが、Meet の画面の作りに依存する（属性で3回外した）。
 * 音声を自前で書き起こせばそこから自由になれる——**ただし話者が失われる**。
 * 混ざった1本の音から誰が喋ったかを当てる（diarization）のは、精度が出にくい。
 *
 * > [!IMPORTANT]
 * > **Russell の記憶は「誰が言ったか」を軸に組んである。** 個人カルテ、決定事項の出どころ、
 * > 「本人が言っていないことを本人の言葉として思い出さない」——全部そこに乗っている。
 * > 話者を捨てると、会議の記録は使えるが**記憶としては弱くなる**。
 *
 * だから折衷する: **中身は音声から、話者は画面から。**
 * 画面に聞くのは「いま誰が喋っているか」だけで、これは字幕の本文を読むより
 * はるかに単純な信号である（参加者のタイルが状態を持っている）。
 *
 * そして**片方が壊れても、もう片方は残る**。話者が取れなければ「誰か」として記録し、
 * **取れなかったことが分かる形**にする——黙って誰かの発言にしない。
 */

import type { TranscriptLine } from "@edv4h/russell-plugin-meeting";

/** 話者が分からなかったときの名前。**空にしない**——記録が「無い」と見分けが付かなくなる。 */
export const UNKNOWN_SPEAKER = "（話者不明）";

/** 音声認識が返す一区切り。時刻は会議の開始からのミリ秒。 */
export interface SpeechSegment {
  from: number;
  to: number;
  text: string;
}

/** 画面から取った「この間、この人が喋っていた」。 */
export interface SpeakingSpan {
  speaker: string;
  from: number;
  to: number;
}

/** 2つの区間が重なっている長さ。重なっていなければ 0。 */
export function overlapMs(
  a: { from: number; to: number },
  b: { from: number; to: number },
): number {
  return Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
}

/**
 * 発言に話者を付ける。**いちばん長く重なっていた人**を選ぶ。
 *
 * 会議では発言が重なる。完全に分けようとすると破綻するので、「その区間で最も長く
 * 喋っていた人」に寄せる。誰とも重ならなければ `UNKNOWN_SPEAKER`——
 * **当てにいかない**（当てた話者は、当てたと分からない）。
 */
export function attributeSpeakers(
  segments: SpeechSegment[],
  spans: SpeakingSpan[],
  at: (ms: number) => string,
): TranscriptLine[] {
  return segments
    .filter((s) => s.text.trim() !== "")
    .map((segment) => {
      let best: { speaker: string; overlap: number } | undefined;
      for (const span of spans) {
        const overlap = overlapMs(segment, span);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) best = { speaker: span.speaker, overlap };
      }
      return {
        speaker: best?.speaker ?? UNKNOWN_SPEAKER,
        text: segment.text.trim(),
        at: at(segment.from),
      };
    });
}

/**
 * 画面から拾った「いま喋っている人」の並びを、区間に畳む。
 *
 * 拾い方は周期的な観測なので、同じ人が続けば1つの区間にする。**細切れのまま持つと、
 * 発言との重なりが正しく測れない**（1秒の発言が10個の観測に割れる）。
 */
export function toSpeakingSpans(
  samples: { speaker: string; at: number }[],
  sampleMs: number,
): SpeakingSpan[] {
  const spans: SpeakingSpan[] = [];
  for (const sample of samples) {
    const speaker = sample.speaker.trim();
    if (speaker === "") continue;
    const last = spans[spans.length - 1];
    // 同じ人が続いている＝同じ区間。**隙間が観測の間隔以内なら繋ぐ**
    if (last && last.speaker === speaker && sample.at - last.to <= sampleMs) {
      last.to = sample.at + sampleMs;
      continue;
    }
    spans.push({ speaker, from: sample.at, to: sample.at + sampleMs });
  }
  return spans;
}
