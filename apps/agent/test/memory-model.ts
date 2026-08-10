/**
 * テスト用のモデル。会話には固定文を返し、記憶の判定には決められた JSON を返す。
 *
 * 記憶の書き込みはモデルの判断で起きるようになったので（P0-3/P0-4）、
 * 「メモが書かれること」を前提にするテストは判定を明示的に組み立てる必要がある。
 */

import type { ModelRequest, RussellPlugin } from "@edv4h/russell-shared";

/** 判定用の呼び出しかどうか。プロンプトの役割で見分ける。 */
export function isDecisionRequest(req: ModelRequest): boolean {
  return req.system.includes("記憶係");
}

export interface ScriptedModel {
  plugin: RussellPlugin;
  /** 会話用の呼び出しだけ（判定用は含まない）。 */
  conversations: ModelRequest[];
  /** 判定用の呼び出しだけ。 */
  decisions: ModelRequest[];
}

/**
 * @param decision 判定として返す JSON 文字列。既定は「何も書かない」。
 *                 ターンごとに変えたいときは関数を渡す（引数は1始まりの判定回数）。
 * @param reply    会話の返答。
 */
export function scriptedModel(
  decision: string | ((turn: number) => string) = '{"note":null,"shelf":null,"forget":null}',
  reply?: string,
): ScriptedModel {
  const conversations: ModelRequest[] = [];
  const decisions: ModelRequest[] = [];
  const plugin: RussellPlugin = {
    id: "scripted-model",
    name: "scripted model",
    setup(ctx) {
      return ctx.models.register({
        id: "echo",
        async complete(req) {
          if (isDecisionRequest(req)) {
            decisions.push(req);
            return { text: typeof decision === "function" ? decision(decisions.length) : decision };
          }
          conversations.push(req);
          return { text: reply ?? `了解しました（${conversations.length}）` };
        },
      });
    },
  };
  return { plugin, conversations, decisions };
}
