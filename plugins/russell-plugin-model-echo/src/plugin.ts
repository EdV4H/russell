/**
 * モデルプラグイン（dev スタブ）。API キー不要の決定論的ダミー。
 * オフラインで認知ループの配線を検証するためのもの。本番は model-claude（Claude API）に差し替える。
 */

import type {
  AgentContext,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RussellPlugin,
} from "@edv4h/russell-shared";

export function createEchoModelPlugin(): RussellPlugin {
  return {
    id: "russell-plugin-model-echo",
    name: "Echo Model (dev stub)",
    setup(ctx: AgentContext) {
      const provider: ModelProvider = {
        id: "echo",
        async complete(req: ModelRequest): Promise<ModelResponse> {
          const user = req.user.trim();
          const first = user.split(/[。\n?？!！]/)[0]?.slice(0, 40) ?? user;
          const hasMemory = /本棚:|メモ:/.test(req.system);
          const isQuestion = /[?？]/.test(user);

          let text: string;
          if (isQuestion) {
            text = `${first}、ですね。確認してお答えします。`;
          } else {
            text = `${first}、了解しました。`;
          }
          if (hasMemory) {
            text = `（覚えている内容も踏まえます）${text}`;
          }
          return { text };
        },
      };
      const off = ctx.models.register(provider);
      return () => off();
    },
  };
}
