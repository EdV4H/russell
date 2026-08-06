/**
 * モデルプラグイン（**開発用**）: ローカルの Claude Code CLI を ModelProvider として使う。
 *
 * API キーが無くても本物の Claude と会話できるようにするためのもの。認証は手元の
 * Claude Code のログインをそのまま使う（env は要らない）。
 *
 * 本番では使えない（`NODE_ENV=production` で拒否）。理由と隔離の設計は invocation.ts。
 *
 * plugin-first の効き所でもある: コアも他のプラグインも一切変えずに、
 * 配列の1要素を差し替えるだけでモデル経路が変わる。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type {
  AgentContext,
  ModelProvider,
  ModelRequest,
  RussellPlugin,
} from "@edv4h/russell-shared";
import { assertClaudeCodeAllowed, buildArgs, readResult } from "./invocation.js";

export interface ClaudeCodeModelOptions {
  /** provider の id（config.model で参照する）。既定 "claude-code"。 */
  id?: string;
  /**
   * `--model` に渡す値。既定 "opus"（最新の Opus の別名）。
   * dev のループを速くしたいなら "sonnet"（実測で1ターン約8秒 → Opus はもう少しかかる）。
   */
  model?: string;
  /** CLI のパス。既定 "claude"（PATH から解決）。 */
  cliPath?: string;
  /** 1ターンの上限。既定 120 秒。超えたら kill する。 */
  timeoutMs?: number;
}

/** stdin にプロンプトを渡し、stdout を返す。シェルを介さない（untrusted テキストを扱うため）。 */
function runClaude(
  cliPath: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // 作業ディレクトリはリポジトリの外に置く。--safe-mode で CLAUDE.md は読まないが、
    // 「たまたまカレントディレクトリの内容が見える」状態を作らない。
    let child: ChildProcess;
    try {
      child = spawn(cliPath, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`model-claude-code: ${timeoutMs}ms で応答がありませんでした`)));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish(() =>
        reject(
          new Error(
            `model-claude-code: CLI を起動できません（${cliPath}）: ${err.message}。Claude Code がインストールされ、ログイン済みか確認してください。`,
          ),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(`model-claude-code: CLI が異常終了しました（${code}）: ${stderr.trim()}`),
          );
      });
    });

    child.stdin?.end(input);
  });
}

export function createClaudeCodeModelPlugin(options: ClaudeCodeModelOptions = {}): RussellPlugin {
  const providerId = options.id ?? "claude-code";
  const model = options.model ?? "opus";
  const cliPath = options.cliPath ?? "claude";
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    id: "russell-plugin-model-claude-code",
    name: "Claude Code CLI Model (dev only)",
    setup(ctx: AgentContext) {
      assertClaudeCodeAllowed();

      const provider: ModelProvider = {
        id: providerId,
        async complete(req: ModelRequest) {
          const stdout = await runClaude(
            cliPath,
            buildArgs({ model, system: req.system }),
            req.user,
            timeoutMs,
          );
          return { text: readResult(stdout) };
        },
      };

      const off = ctx.models.register(provider);
      return () => off();
    },
  };
}
