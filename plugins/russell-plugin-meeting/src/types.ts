/**
 * 会議に参加する経路の契約。
 *
 * **どうやって入るかは、ここでは決めない。** Google Meet Media API でも、第三者の
 * 録画ボットでも、試験用の偽物でも、同じ形で差し替えられるようにしてある——
 * 経路の可否（申請・承認・プランの制約）は外の事情で決まるので、
 * **それを待たずに中身を作れる**必要がある（`surface-cli` と同じ考え方）。
 */

/** 会議での1発言。**誰が言ったか**を落とさない（複数人の会話が1人に見えないように）。 */
export interface TranscriptLine {
  speaker: string;
  text: string;
  /** 発言の時刻（ISO8601）。後から並べ直せるように持つ。 */
  at: string;
}

/** 参加中の会議。 */
export interface MeetingSession {
  /** 参加した会議の識別子（URL など、人が見て分かるもの）。 */
  id: string;
  /**
   * 会議の名前。**入ってから分かるもの**で、取れなければ `undefined`。
   *
   * 以前は参加を頼む側（モデル）に名乗らせていたが、**入る前に会議名を知る手段は無い**
   * ので、そこに入るのは作り話だった（URL の会議コードや会話から推測した名前）。
   * 分からないなら分からないままにする——**当てた名前は、当てたと分からない**。
   */
  title?: string;
  /** 文字起こしが届くたびに呼ばれる。 */
  onLine(handler: (line: TranscriptLine) => void): void;
  /** 会議から出る。**失敗しても投げない**——出られないことで会話を壊さない。 */
  leave(): Promise<void>;
}

export interface MeetingProvider {
  /** どの経路か（監査とログに出す。「何で入ったか」が後から分かるように）。 */
  id: string;
  join(input: { url: string }): Promise<MeetingSession>;
}
