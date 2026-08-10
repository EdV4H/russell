/**
 * 会話の文脈を取り直す契約（ADR 0001）。
 *
 * 短期記憶はプロセス内にしかないので再起動で消える。**保存する代わりに、必要になった時点で
 * 取り直す**——会話は通信面（Slack 等）に既にあるので、二重に持たない。
 *
 * コアは Slack を知らないので、実装は通信面プラグインが `ctx.services.provide` で置く。
 * 置かない通信面（CLI 等）では、コアは従来どおり自前の短期記憶だけで動く。
 */

import type { ModelTurn } from "./runtime.js";

export interface ConversationCapability {
  /**
   * その文脈の直近のやりとりを古い順に返す。取れなければ空配列。
   *
   * **今まさに処理中の発言は含めない**（コアが `user` として別に渡すため、
   * 含めると同じ発言が2回モデルに入る）。
   */
  history(contextId: string): Promise<ModelTurn[]>;
}

/** services のキー。 */
export const CONVERSATION_SERVICE = "conversation";
