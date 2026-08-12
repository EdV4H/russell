/**
 * worker が使うモデル経路の選択。**agent と同じ規則で選ぶ。**
 *
 * 以前は worker だけが開発用の Claude Code CLI を直叩きしていた。CLI は本番
 * （`NODE_ENV=production`）で拒否されるので、**サーバーでは日報が書けない**状態だった。
 * 選び方が2箇所に分かれていると、こういう食い違いは必ず起きる。
 *
 * 規則は agent（`apps/agent/src/main.ts`）と同じ:
 *   ANTHROPIC_API_KEY があれば API、無ければ開発用の CLI（明示的な opt-in のとき）。
 */

import { createClaudeProvider } from "@edv4h/russell-plugin-model-claude";
import { createClaudeCodeProvider } from "@edv4h/russell-plugin-model-claude-code";
import type { ModelProvider } from "@edv4h/russell-shared";

export interface ResolvedModel {
  provider?: ModelProvider;
  /** どの経路を選んだか（ログに出す。**選ばれなかったことも見えるように**）。 */
  route: "claude" | "claude-code" | "none";
  reason?: string;
}

export function resolveModelProvider(): ResolvedModel {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: createClaudeProvider({
        // 判定系は安いモデルへ寄せられる（設計はスコアラーに Haiku 想定, §6）
        model: process.env.RUSSELL_MEMORY_MODEL,
      }),
      route: "claude",
    };
  }
  // 開発用の経路。**明示的な opt-in のときだけ**（勝手に CLI プロセスを起動しない）
  if (process.env.RUSSELL_MODEL === "claude-code") {
    try {
      return {
        provider: createClaudeCodeProvider({
          model: process.env.RUSSELL_CLAUDE_CODE_MODEL ?? "sonnet",
        }),
        route: "claude-code",
      };
    } catch (err) {
      return { route: "none", reason: String(err) };
    }
  }
  return {
    route: "none",
    reason: "ANTHROPIC_API_KEY が無く、RUSSELL_MODEL も claude-code ではありません",
  };
}
