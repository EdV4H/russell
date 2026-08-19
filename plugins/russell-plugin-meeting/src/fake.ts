/**
 * 試験用の会議プロバイダ。**外部に一切繋がらない。**
 *
 * 本物の経路（Meet Media API）は申請と承認が要るので、それを待っていると
 * 中身の作り込みが止まる。台本を渡すと、その通りに発言が流れてくる。
 */

import type { MeetingProvider, MeetingSession, TranscriptLine } from "./types.js";

export interface FakeMeetingOptions {
  /** 参加した直後に流す発言。 */
  script?: TranscriptLine[];
  /** join を失敗させる（入れないときの振る舞いを試すため）。 */
  failJoin?: boolean;
}

export function createFakeMeetingProvider(options: FakeMeetingOptions = {}): MeetingProvider & {
  /** 試験の途中から発言を足す。 */
  emit(line: TranscriptLine): void;
  /** 出たかどうか。 */
  left: boolean;
} {
  const handlers: ((line: TranscriptLine) => void)[] = [];
  const state = { left: false };

  return {
    id: "fake",
    get left() {
      return state.left;
    },
    emit(line: TranscriptLine) {
      for (const h of handlers) h(line);
    },
    async join(input): Promise<MeetingSession> {
      if (options.failJoin) throw new Error("会議に入れませんでした");
      const session: MeetingSession = {
        id: input.url,
        onLine(handler) {
          handlers.push(handler);
          for (const line of options.script ?? []) handler(line);
        },
        async leave() {
          state.left = true;
        },
      };
      return session;
    },
  };
}
