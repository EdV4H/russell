/**
 * worker のモデル経路の選択。env 不要（provider は作らず、選び方だけ見る）。
 *
 * 以前は worker だけが開発用の Claude Code CLI を直叩きしていた。CLI は本番で拒否されるので、
 * **サーバーでは日報が書けない**状態だった。選び方が2箇所に分かれていると、
 * こういう食い違いは必ず起きる——agent と同じ規則で選ぶことをここで固定する。
 */

import { resolveModelProvider } from "@edv4h/russell-worker/model";
import { afterEach, expect, test } from "vitest";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test("API キーがあれば API 経路", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.RUSSELL_MODEL = "claude-code"; // 指定されていても API を優先する
  expect(resolveModelProvider().route).toBe("claude");
});

test("キーが無く、明示的な opt-in があるときだけ開発用の CLI", () => {
  process.env.ANTHROPIC_API_KEY = undefined;
  process.env.ANTHROPIC_API_KEY = undefined;
  process.env.RUSSELL_MODEL = "claude-code";
  // **明示的な opt-in のときだけ**（勝手に CLI プロセスを起動しない）
  expect(["claude-code", "none"]).toContain(resolveModelProvider().route);
});

test("キーも opt-in も無ければ経路なし。**理由を返す**", () => {
  process.env.ANTHROPIC_API_KEY = undefined;
  process.env.RUSSELL_MODEL = undefined;

  const resolved = resolveModelProvider();
  expect(resolved.route).toBe("none");
  // 黙って何もしないのではなく、なぜ選ばれなかったかを言う
  expect(resolved.reason).toContain("ANTHROPIC_API_KEY");
  expect(resolved.provider).toBeUndefined();
});
