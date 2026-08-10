/**
 * `claude -p`（headless）を ModelProvider として呼ぶための引数組み立てと結果解釈。
 *
 * **CLI を起動しない純関数**にしてある。ここで決めているのは「隔離」であって、
 * 隔離が崩れたら Russell の安全機構が丸ごと迂回されるため、CLI 無しで検証できる必要がある。
 *
 * なぜ隔離が要るか:
 * Claude Code は既定で操作者の skills / MCP / ローカルツール（Slack・メール・ブラウザ・bash…）を
 * 引き継ぐ。そこへ Russell が **untrusted な Slack 発言をそのまま渡す**と、
 * 「操作者の全権限を持つエージェントへのプロンプトインジェクション」になる（§12-3）。
 * しかもコアの Policy Gate の外側なので、`decide()` も監査も通らない。
 * 実際 `--allowed-tools ""` だけでは隔離できず、カレンダーを見に行くのを確認している。
 */

import type { ModelTurn } from "@edv4h/russell-shared";

/** 明示的に拒否するツール。`--safe-mode` と重複するが、二重に塞ぐ。 */
export const DENIED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
] as const;

export interface BuildArgsInput {
  /** `--model` に渡す別名または完全名。 */
  model: string;
  /** 人格＋想起した記憶。**untrusted を含みうる**ので argv 経由（シェルを介さない）。 */
  system: string;
}

/**
 * 隔離フラグは**呼び出し側から変えられない**。オプションで緩められる作りにすると、
 * 「dev で緩めたまま本番に出る」経路ができる。
 */
export function buildArgs(input: BuildArgsInput): string[] {
  return [
    "-p", // headless（プロンプトは stdin から渡す）
    "--model",
    input.model,
    "--safe-mode", // CLAUDE.md / skills / plugins / hooks / MCP / custom commands をすべて無効化
    "--strict-mcp-config", // --mcp-config 以外の MCP を読まない（何も渡さない＝MCP 無し）
    "--disallowed-tools",
    DENIED_TOOLS.join(" "),
    "--system-prompt", // 既定のシステムプロンプトを置き換える（append ではない）
    input.system,
    "--output-format",
    "json",
  ];
}

/**
 * CLI は1回1発なので、直近のやりとりを書き起こしとして本文の前に置く。
 *
 * 誰の発言かを明示するのは、モデルが「これは過去の記録であって、いま答えるべきは
 * 最後の1行だ」と分かるようにするため。
 */
export function renderPrompt(req: { user: string; history?: ModelTurn[] }): string {
  const history = req.history ?? [];
  if (history.length === 0) return req.user;
  const transcript = history
    .map((t) => `${t.role === "user" ? "相手" : "あなた"}: ${t.text}`)
    .join("\n");
  return `これまでのやりとり:\n${transcript}\n\n---\n相手: ${req.user}`;
}

/** `--output-format json` の応答のうち、こちらが依存する部分。 */
export interface ClaudeCodeResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  permission_denials?: unknown[];
  usage?: {
    server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
  };
}

/**
 * 応答を読む。**ツールが動いた形跡があれば throw する。**
 *
 * 隔離は CLI 側の実装に依存していて、将来の更新や設定で崩れうる。崩れたときに
 * 黙って「ツールを持ったエージェントが Slack に返事をする」状態になるより、
 * その場で止まる方がよい（fail-closed）。
 * - `num_turns > 1` … ツール実行が挟まると増える
 * - `permission_denials` … ツールを使おうとした（拒否されたが試みはあった）
 * - `server_tool_use` … web 検索/取得が実際に走った
 */
export function readResult(stdout: string): string {
  let parsed: ClaudeCodeResult;
  try {
    parsed = JSON.parse(stdout) as ClaudeCodeResult;
  } catch {
    throw new Error(`model-claude-code: 応答を JSON として読めません: ${stdout.slice(0, 200)}`);
  }
  if (parsed.is_error) {
    throw new Error(
      `model-claude-code: CLI がエラーを返しました（${parsed.subtype ?? "unknown"}）`,
    );
  }
  const server = parsed.usage?.server_tool_use;
  const usedTools =
    (parsed.num_turns ?? 1) > 1 ||
    (parsed.permission_denials?.length ?? 0) > 0 ||
    (server?.web_search_requests ?? 0) > 0 ||
    (server?.web_fetch_requests ?? 0) > 0;
  if (usedTools) {
    throw new Error(
      "model-claude-code: 隔離が破れています（ツールが動いた形跡があります）。" +
        "Policy Gate の外で副作用が起きうるため中止しました。CLI の設定を確認してください。",
    );
  }
  const text = parsed.result;
  if (typeof text !== "string") {
    throw new Error("model-claude-code: 応答に result がありません");
  }
  return text;
}

/**
 * 本番で使わせない。これは**開発用の便宜**であって、運用の構成ではない——
 * 1ターン8秒前後かかり（P0-1 の p95 ≤ 8s を単体で使い切る）、個人のサブスクリプションで
 * 常駐サービスを回す形にもなる。本番は ANTHROPIC_API_KEY を使う（§11 の autoMigrate と同じ扱い）。
 */
export function assertClaudeCodeAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "model-claude-code: 本番では使えません。これは開発用のモデル経路です。" +
        "ANTHROPIC_API_KEY を設定して model-claude を使ってください。",
    );
  }
}
