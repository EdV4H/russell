/**
 * 実行モード（§6.5）。`off → dryrun → live` の段階を**実際に効かせる**。
 *
 * これまで `mode` は `agent.started` の監査 payload に載るだけで、判定に一度も使われて
 * いなかった（#32）。つまり **dryrun でも実際に Slack へ投稿していた**。
 * 「dryrun で妥当率を測ってから live へ昇格する」という運用（dryrun-to-live-promotion）が
 * そもそも成立していなかった。
 *
 * 判定は純関数にしてある。**どのモードで何が止まるか**は運用が読む仕様そのものなので、
 * 実装の奥に埋めずに1か所で読めるようにしておきたい。
 */

import type { EffectClass, Mode } from "@edv4h/russell-shared";

/**
 * そのモードでツールを実行してよいか。
 *
 * - `live` — すべて実行する
 * - `dryrun` — **外部へ出るものだけ止める。** 記憶（`internal_write`）は書く。
 *   記憶の挙動こそ試したい対象で、しかも個体の内部に閉じているため
 * - `off` — 読み取りすら行わない。**動いていないのと同じ**にする
 */
export function modeAllowsTool(mode: Mode, effect: EffectClass): boolean {
  if (mode === "live") return true;
  if (mode === "off") return false;
  return effect === "read" || effect === "internal_write";
}

/**
 * そのモードで外部へ送信してよいか（返答・投稿）。
 *
 * **dryrun では送らない。** 返信も外部への送信なので、ここを通すと
 * 「本番ワークスペースに繋いだが dryrun だから安全」が嘘になる——#32 が起票された動機そのもの。
 */
export function modeAllowsSend(mode: Mode): boolean {
  return mode === "live";
}

/** 監査とログに残す理由。`mode` の値をそのまま使うと運用が読みにくい。 */
export function modeSuppressionReason(mode: Mode): string {
  return mode === "off" ? "mode_off" : "mode_dryrun";
}

/** 日報を投稿してよいか。**mode と中身の両方**で決まる。 */
export interface PublishDecision {
  publish: boolean;
  /** 投稿しない理由。運用が読むのでそのままログと監査に出す。 */
  reason?: "mode_off" | "mode_dryrun" | "empty";
}

/**
 * その日の日報を投稿するか。
 *
 * **出来事が無い日は投稿しない。** 「今日は記録すべき出来事はなかった」を毎朝流すのは、
 * 透明性ではなく雑音になる。日記そのものは（記録として）書かれている。
 */
export function shouldPublishJournal(mode: Mode, events: number): PublishDecision {
  if (events <= 0) return { publish: false, reason: "empty" };
  if (!modeAllowsSend(mode)) {
    return { publish: false, reason: mode === "off" ? "mode_off" : "mode_dryrun" };
  }
  return { publish: true };
}
