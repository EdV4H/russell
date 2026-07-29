/**
 * モデルプラグイン: Claude API（本番）。
 * `ctx.models` に provider を登録する。ANTHROPIC_API_KEY（env）で認証。
 *
 * モデル選定（設計書 §11 / cost-budget）: 会話は既定で Claude Sonnet 5。
 * options.model で差し替え可能（フィルタ/夜間バルクを Haiku にする、石橋を Opus にする等）。
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentContext,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RussellPlugin,
} from "@edv4h/russell-shared";

export interface ClaudeModelOptions {
  /** provider の id（config.model で参照する）。既定 "claude"。 */
  id?: string;
  /** モデル ID。既定 "claude-sonnet-5"（会話用, §11）。 */
  model?: string;
  /** 応答の最大トークン（§11: 応答 ~2k）。既定 2048。 */
  maxTokens?: number;
  /** API キー。未指定なら env ANTHROPIC_API_KEY。 */
  apiKey?: string;
}

export function createClaudeModelPlugin(options: ClaudeModelOptions = {}): RussellPlugin {
  const providerId = options.id ?? "claude";
  const model = options.model ?? "claude-sonnet-5";
  const maxTokens = options.maxTokens ?? 2048;

  return {
    id: "russell-plugin-model-claude",
    name: "Claude Model",
    setup(ctx: AgentContext) {
      const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});

      const provider: ModelProvider = {
        id: providerId,
        async complete(req: ModelRequest): Promise<ModelResponse> {
          const res = await client.messages.create({
            model,
            max_tokens: maxTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
          });
          const text = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          return { text };
        },
      };

      const off = ctx.models.register(provider);
      return () => off();
    },
  };
}
