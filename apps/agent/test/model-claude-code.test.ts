/**
 * 開発用モデル経路（ローカルの Claude Code CLI）の検証。CLI もキーも要らない。
 *
 * 一番大事なのは**隔離**。Claude Code は既定で操作者の skills / MCP / ローカルツールを
 * 引き継ぐので、そこへ untrusted な Slack 発言を渡すと、Policy Gate の外側にいる
 * 「全権限を持つエージェント」へのプロンプトインジェクションになる（§12-3）。
 */

import { createAgent } from "@edv4h/russell-core";
import {
  DENIED_TOOLS,
  assertClaudeCodeAllowed,
  buildArgs,
  createClaudeCodeModelPlugin,
  readResult,
} from "@edv4h/russell-plugin-model-claude-code";
import type { Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/** 応答 JSON の雛形（実際の `--output-format json` から必要な項目だけ抜いたもの）。 */
const ok = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    is_error: false,
    subtype: "success",
    num_turns: 1,
    permission_denials: [],
    usage: { server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } },
    result: "こんにちは。",
    ...over,
  });

test("隔離フラグは常に付く（呼び出し側から外せない）", () => {
  const args = buildArgs({ model: "opus", system: "あなたはBobです。" });

  expect(args).toContain("--safe-mode"); // CLAUDE.md / skills / plugins / hooks / MCP を無効化
  expect(args).toContain("--strict-mcp-config"); // 外部の MCP 設定を読まない
  expect(args).toContain("--disallowed-tools");
  for (const tool of DENIED_TOOLS) {
    expect(args[args.indexOf("--disallowed-tools") + 1]).toContain(tool);
  }
  // 既定のシステムプロンプトへの追記ではなく置き換え
  expect(args).toContain("--system-prompt");
  expect(args).not.toContain("--append-system-prompt");
});

test("システムプロンプトは argv の1要素として渡す（シェルを経由しない）", () => {
  // 想起した記憶には他人の発言（untrusted）が入りうる。文字列連結してシェルに渡すと
  // そこがインジェクション点になるので、引数の1要素として素通しであることを確かめる。
  const nasty = 'メモ: "; rm -rf / #\n$(whoami) `id`';
  const args = buildArgs({ model: "opus", system: nasty });

  expect(args[args.indexOf("--system-prompt") + 1]).toBe(nasty);
  expect(args.filter((a) => a === nasty).length).toBe(1);
});

test("正常な応答は本文だけを返す", () => {
  expect(readResult(ok())).toBe("こんにちは。");
});

test("**動いた**形跡があれば中止する（隔離が破れたら止まる）", () => {
  // 拒否が1件も無いのにターンが増えている = 何かが通った
  expect(() => readResult(ok({ num_turns: 3 }))).toThrow(/隔離/);
  // サーバ側ツールが実際に走った
  expect(() => readResult(ok({ usage: { server_tool_use: { web_search_requests: 1 } } }))).toThrow(
    /隔離/,
  );
});

test("**試みて拒否されただけなら、答えを捨てない**（隔離は働いている）", () => {
  // 以前はここで中止していたので、防ぎ切ったのに「うまく応答できませんでした」になっていた。
  // 拒否は副作用が起きていない証拠で、答えは使える
  expect(readResult(ok({ permission_denials: [{ tool_name: "WebSearch" }] }))).toBe("こんにちは。");
  // 拒否に伴ってターンが増えるのは自然（試行そのものがターンを消費する）
  expect(readResult(ok({ num_turns: 3, permission_denials: [{ tool_name: "WebSearch" }] }))).toBe(
    "こんにちは。",
  );
});

test("拒否されても、サーバ側ツールが走っていれば中止する", () => {
  // 片方が拒否されても、もう片方が**実際に動いていれば**副作用は起きている
  expect(() =>
    readResult(
      ok({
        permission_denials: [{ tool_name: "Read" }],
        usage: { server_tool_use: { web_fetch_requests: 1 } },
      }),
    ),
  ).toThrow(/隔離/);
});

test("CLI のエラーや壊れた出力は握り潰さない", () => {
  expect(() => readResult(ok({ is_error: true, subtype: "error_max_turns" }))).toThrow(
    /error_max_turns/,
  );
  expect(() => readResult("not json")).toThrow(/JSON/);
  expect(() => readResult(ok({ result: undefined }))).toThrow(/result/);
});

test("本番では使えない（キーを使う経路へ倒す）", async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    expect(() => assertClaudeCodeAllowed()).toThrow(/本番では使えません/);

    // 組み立て時点で落ちる（起動してから気づく、にしない）
    await expect(
      createAgent({ agentId: "bob", configVersion: "v0", temperament: BOB }, [
        createClaudeCodeModelPlugin(),
      ]),
    ).rejects.toThrow(/本番では使えません/);
  } finally {
    process.env.NODE_ENV = original ?? "test";
  }
});
