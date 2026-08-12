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

/**
 * 直近のやりとり＋今回の発言を Messages API の形にする。
 *
 * 先頭が assistant で始まる配列は API が受け取らない。バッファが途中で切り詰められると
 * そうなりうるので、先頭の assistant を落としてから組む。
 */
export function toMessages(req: ModelRequest): Anthropic.MessageParam[] {
  const history = [...(req.history ?? [])];
  while (history[0]?.role === "assistant") history.shift();
  return [
    ...history.map((t) => ({ role: t.role, content: t.text }) as Anthropic.MessageParam),
    { role: "user" as const, content: req.user },
  ];
}

/**
 * ModelProvider だけを作る。**worker のようにコアの外にいるプロセス**が、
 * プラグイン機構を通さずにモデルを呼びたいときに使う（夜間バッチ・dispatcher）。
 *
 * 切り出してあるのは、**agent と worker でモデル経路が食い違わないようにする**ため。
 * 以前は worker だけが開発用の CLI を直叩きしていて、本番では日報が書けない状態だった。
 */
export function createClaudeProvider(options: ClaudeModelOptions = {}): ModelProvider {
  const providerId = options.id ?? "claude";
  const model = options.model ?? "claude-sonnet-5";
  const maxTokens = options.maxTokens ?? 4096;
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});

  return {
    id: providerId,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: req.system,
        messages: toMessages(req),
      });
      return {
        text: res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(""),
      };
    },
  };
}

export function createClaudeModelPlugin(options: ClaudeModelOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-model-claude",
    name: "Claude Model",
    setup(ctx: AgentContext) {
      const off = ctx.models.register(createClaudeProvider(options));
      return () => off();
    },
  };
}
