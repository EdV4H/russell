/**
 * ルーティンの実行判定（§5.1 dispatcher 方式）。
 *
 * 静的 cron の直接実行をやめ、**固定間隔 tick で「実行期限を迎えたもの」を DB から claim する**
 * 方式を採る。理由は復旧時の挙動にある——プロセスが止まっていた間の予定をどう扱うかを、
 * cron 自身は決められない。
 *
 * ここは**時刻の計算だけの純関数**。「止まっていた3日分をどうするか」は運用の判断であり、
 * 実装の奥に埋めずに1か所で読めるようにしておきたい。
 */

/**
 * 止まっていた間の予定の扱い（§5.1）。
 *
 * 既定が `coalesce` なのは、**復旧直後に朝の挨拶が5連投される**事態を構造的に防ぐため。
 * 「動いていなかった間の分を全部やり直す」より「今の状態を1回だけ報告する」方が同僚らしい。
 */
export type CatchupPolicy = "skip" | "coalesce" | "replay_once";

export interface DueOptions {
  /** 直前の予定時刻（未実行のものを含む）。過去のものから昇順。 */
  missed: Date[];
  policy?: CatchupPolicy;
}

/**
 * 取りこぼした予定のうち、**実際に実行するもの**を返す。
 *
 * - `skip` — 何も実行しない。止まっていた分は無かったことにする
 * - `coalesce`（既定）— **最新の1回だけ**。今の状態を1回報告すれば足りる種類の仕事向け
 * - `replay_once` — 取りこぼした分を1回ずつ。日報のように**その日ごとに意味がある**もの向け
 */
export function resolveCatchup({ missed, policy = "coalesce" }: DueOptions): Date[] {
  if (missed.length === 0) return [];
  if (policy === "skip") return [];
  if (policy === "replay_once") return [...missed];
  const latest = missed[missed.length - 1];
  return latest ? [latest] : [];
}

/**
 * リースが切れているか。
 *
 * 実行中のプロセスが落ちると、claim したまま誰も進めない状態になる。heartbeat が
 * 途絶えたら別のプロセスが引き取れるようにする——ただし**引き取れるだけで、
 * 実行が二重になってはいけない**ので、論理的な一意性は `scheduled_for` の一意制約が担保する。
 */
export function leaseExpired(heartbeatAt: Date | null, now: Date, leaseMs: number): boolean {
  if (!heartbeatAt) return true;
  return now.getTime() - heartbeatAt.getTime() > leaseMs;
}

/** 実行結果（§5.1）。**「報告事項ゼロ」と「取得に失敗して何も無いように見える」を分ける。** */
export type RunStatus =
  | "succeeded"
  /** 正常に処理して、報告することが無かった。**全ソースを取得できたときだけ**名乗れる（§6.2 完全性契約） */
  | "succeeded_zero"
  /** 一部のソースが取れないまま処理した。「動きなし」とは言えない */
  | "degraded"
  | "failed"
  | "skipped";
