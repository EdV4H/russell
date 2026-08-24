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

/**
 * 明示的に拒否するツール。`--safe-mode` と重複するが、二重に塞ぐ。
 *
 * **このリストは必ず不完全である。** CLI が持つツールは版によって増え、名前も変わる。
 * 実際 `ToolSearch` はここに無かったせいで動き、`readResult` の `num_turns` チェックが
 * 拾って**ターンごと中止**された（＝ Bob が黙る）。
 *
 * だからここは「よく踏むものを塞いで無用な中止を減らす」ための便宜であって、
 * **隔離の保証は readResult 側の検査**にある。名前を足すのは対症療法だと理解して足すこと。
 */
export const DENIED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
  "ToolSearch",
  "Skill",
  "SlashCommand",
  "AskUserQuestion",
  "ExitPlanMode",
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
 *
 * > [!IMPORTANT]
 * > **「試みて拒否された」は、破れていない。** 以前は `permission_denials` があるだけで
 * > 中止していたので、**防ぎ切った場合まで**ターンごと捨てていた（利用者からは
 * > 「うまく応答できませんでした」に見える）。拒否は隔離が**働いた**証拠であって、
 * > 副作用は起きていない。
 * >
 * > 見るべきなのは「試みたか」ではなく「**動いたか**」である:
 * > - `server_tool_use` … web 検索/取得が**実際に走った** → 破れている
 * > - `num_turns > 1` なのに拒否が1件も無い … **何かが通った** → 破れている
 * > - 拒否があるだけ … 塞げている → **答えを使う**（ただし黙らずに警告を出す）
 */
/** 拒否された道具の名前。**名前だけ**（入力は載せない。何が入っているか分からない）。 */
function deniedNames(denials: unknown[]): string {
  const names = denials
    .map((d) =>
      typeof d === "object" && d !== null
        ? ((d as Record<string, unknown>).tool_name ?? (d as Record<string, unknown>).tool)
        : undefined,
    )
    .filter((n): n is string => typeof n === "string");
  return names.length > 0 ? [...new Set(names)].join(", ") : "名前不明";
}

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
  const denied = parsed.permission_denials ?? [];
  const ranServerTool =
    (server?.web_search_requests ?? 0) > 0 || (server?.web_fetch_requests ?? 0) > 0;
  // ツールの試行はターン数を増やす。**拒否で説明がつかない増分**は「通った」ということ
  const unexplainedTurns = (parsed.num_turns ?? 1) > 1 && denied.length === 0;

  if (denied.length > 0 && !ranServerTool) {
    // **塞げている。** ただし黙って流さない——同じ道具を繰り返し試すなら、
    // 拒否リストに足すか、指示を直す必要がある（この行が唯一の手がかりになる）
    console.warn(
      `[model-claude-code] ツールの使用を拒否しました（${denied.length}件: ${deniedNames(denied)}）。応答はそのまま使います。`,
    );
  }

  if (ranServerTool || unexplainedTurns) {
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
