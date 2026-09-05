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
    // **道具が動いたかどうかを、実際に見るため**に stream を使う（readResult の注意書き）。
    // `json` には「何が動いたか」が一切残らず、`num_turns` という代理指標しか無い。
    "--output-format",
    "stream-json",
    "--verbose", // `-p` で stream-json を出すのに要る
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

/** `--output-format stream-json` の最後に来る `result` 事件のうち、依存する部分。 */
export interface ClaudeCodeResult {
  type?: string;
  result?: string;
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  permission_denials?: unknown[];
  usage?: {
    server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
  };
}

/** 流れてくる事件（`assistant` / `user` / `system` / `result`）。 */
interface StreamEvent extends ClaudeCodeResult {
  message?: { content?: unknown };
}

/**
 * 道具の形跡。**名前だけ**を持つ（入力も結果も載せない, A1-5）。
 *
 * 「試みた」と「動いた」を**分けて**持つのが要点である。混ぜると、
 * 隔離が働いた場面まで破れた扱いになる。
 */
export interface ToolTrace {
  /** 実際に動いてしまったもの。**これがあれば隔離は破れている。** */
  ran: string[];
  /** 試みたが弾かれたもの。**隔離が働いた証拠**であって、破れてはいない。 */
  blocked: string[];
}

/** 行ごとの JSON を読む。読めない行は飛ばす（CLI は警告を混ぜることがある）。 */
/**
 * `permission_denials` に載った道具の名前（旧経路）。
 *
 * CLI の版によっては弾いた道具がこちらに載る。**名前だけ**（入力は載せない——
 * 何が入っているか分からない）。いまは `tool_result` の `is_error` 側が主だが、
 * どちらに載るかは CLI の実装なので、両方から拾う。
 */
function deniedNames(denials: unknown[]): string[] {
  const names = denials
    .map((d) =>
      typeof d === "object" && d !== null
        ? ((d as Record<string, unknown>).tool_name ?? (d as Record<string, unknown>).tool)
        : undefined,
    )
    .filter((n): n is string => typeof n === "string");
  if (denials.length === 0) return [];
  return names.length > 0 ? [...new Set(names)] : ["名前不明"];
}

export function parseStream(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    try {
      events.push(JSON.parse(text) as StreamEvent);
    } catch {
      // 途中の1行が読めないだけで全部捨てない（result が読めなければ後で落ちる）
    }
  }
  return events;
}

/**
 * 何が動いて、何が弾かれたかを読む。
 *
 * > [!IMPORTANT]
 * > **結果が読めない道具は「動いた」に倒す**（fail-closed）。分からないものを
 * > 「弾かれた」に倒すと、破れているのに通してしまう。逆は黙るだけで済む。
 */
export function readToolTrace(events: StreamEvent[]): ToolTrace {
  /** tool_use_id → 道具の名前。 */
  const names = new Map<string, string>();
  /** tool_use_id → 弾かれたか。 */
  const rejected = new Map<string, boolean>();

  for (const ev of events) {
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.id === "string") {
        names.set(b.id, typeof b.name === "string" ? b.name : "名前不明");
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        rejected.set(b.tool_use_id, b.is_error === true);
      }
    }
  }

  const ran = new Set<string>();
  const blocked = new Set<string>();
  for (const [id, name] of names) {
    if (rejected.get(id) === true) blocked.add(name);
    else ran.add(name); // 結果が無い＝確かめられない → 動いた扱い
  }
  return { ran: [...ran], blocked: [...blocked] };
}

/**
 * 応答を読む。**ツールが実際に動いていれば throw する。**
 *
 * 隔離は CLI 側の実装に依存していて、将来の更新や設定で崩れうる。崩れたときに
 * 黙って「ツールを持ったエージェントが Slack に返事をする」状態になるより、
 * その場で止まる方がよい（fail-closed）。
 *
 * > [!IMPORTANT]
 * > **「試みて弾かれた」は、破れていない。**
 * >
 * > この間違いは**二度起きている**。一度目は `permission_denials` があるだけで中止していた。
 * > 二度目は、CLI が塞ぎ方を変えた——弾いた道具を `permission_denials` に載せず、
 * > `tool_result` の `is_error` として返すようになった。こちらは
 * > 「`num_turns > 1` なのに拒否が0件なら通った」という**代理指標**で見ていたので、
 * > **弾かれた試行を「破れた」と読んだ**。実測:
 * >
 * > ```
 * > tool_use    name=Bash
 * > tool_result is_error=true :: No such tool available: Bash. Bash is disabled…
 * > → num_turns=2 / permission_denials=[] → 「隔離が破れています」
 * > ```
 * >
 * > 隔離は完璧に働いていたのに、**Bob は毎回「うまく応答できませんでした」と謝っていた**。
 * >
 * > 代理指標をやめ、**`tool_use` と `tool_result` を突き合わせて実際に見る**。
 * > `num_turns` は証拠として残すだけで、判断には使わない。
 */
export function readResult(stdout: string): string {
  const events = parseStream(stdout);
  const final = events.find((e) => e.type === "result");
  if (!final) {
    // **読めないものを通さない。** 何が起きたか分からないまま返事をさせない
    throw new Error(`model-claude-code: 応答の終端（result）が読めません: ${stdout.slice(0, 200)}`);
  }
  if (final.is_error) {
    throw new Error(`model-claude-code: CLI がエラーを返しました（${final.subtype ?? "unknown"}）`);
  }

  const server = final.usage?.server_tool_use;
  const denied = final.permission_denials ?? [];
  const ranServerTool =
    (server?.web_search_requests ?? 0) > 0 || (server?.web_fetch_requests ?? 0) > 0;
  const trace = readToolTrace(events);

  if (trace.blocked.length > 0 || denied.length > 0) {
    // **塞げている。** ただし黙って流さない——同じ道具を繰り返し試すなら、
    // 拒否リストに足すか、指示を直す必要がある（この行が唯一の手がかりになる）
    console.warn(
      `[model-claude-code] 道具の使用を弾きました（${[...trace.blocked, ...deniedNames(denied)].join(", ")}）。隔離は働いています。応答はそのまま使います。`,
    );
  }

  if (trace.ran.length > 0 || ranServerTool) {
    // **何を見てそう言ったのかを残す。** 本文は入れない（A1-5）——名前と数だけで、
    // 「本当に動いたのか」「弾かれただけなのか」を後から判断できる。
    const evidence = [
      `ran=${trace.ran.join("/") || "なし"}`,
      `blocked=${trace.blocked.join("/") || "なし"}`,
      `num_turns=${final.num_turns ?? "?"}`,
      `denials=${denied.length}`,
      `web_search=${server?.web_search_requests ?? 0}`,
      `web_fetch=${server?.web_fetch_requests ?? 0}`,
      `subtype=${final.subtype ?? "?"}`,
    ].join(" ");
    throw new Error(
      `model-claude-code: 隔離が破れています（道具が実際に動きました）。Policy Gate の外で副作用が起きうるため中止しました（${evidence}）。CLI の設定を確認してください。`,
    );
  }

  const text = final.result;
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
