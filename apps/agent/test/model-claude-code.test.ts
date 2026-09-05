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

/**
 * 応答の雛形。**実際の `--output-format stream-json` の形**（行ごとの JSON）。
 *
 * 形は実測から取っている。ここを想像で書くと、**診断が本番と食い違って嘘をつく**——
 * 実際、`json` 形式には「何が動いたか」が一切残らないことに気づくのが遅れた。
 */
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

/** 道具の試行1回分（assistant の tool_use → user の tool_result）。 */
const toolAttempt = (name: string, id: string, opts: { rejected: boolean }) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name }] } }) +
  line({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          // 弾かれたときだけ is_error が立つ（動いたときは付かない）
          ...(opts.rejected ? { is_error: true, content: "No such tool available" } : {}),
        },
      ],
    },
  });

/** 結果まで含んだ一連の流れ。 */
const ok = (over: Record<string, unknown> = {}, before = "") =>
  line({ type: "system", subtype: "init" }) +
  before +
  line({ type: "assistant", message: { content: [{ type: "text", text: "こんにちは。" }] } }) +
  line({
    type: "result",
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

/**
 * **何が動いたかを見られる形で受け取る。**
 *
 * `--output-format json` には道具の記録が一切残らず、`num_turns` という代理指標しか無い。
 * それで「弾かれた試行」を「破れた」と読み違えた（下のテスト参照）。
 */
test("**道具の記録が残る出力形式を使う**（代理指標で判断しないため）", () => {
  const args = buildArgs({ model: "opus", system: "あなたはBobです。" });

  expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(args).toContain("--verbose"); // `-p` で stream-json を出すのに要る
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
  // 道具が実際に動いた（結果にエラーが付いていない）
  expect(() =>
    readResult(ok({ num_turns: 2 }, toolAttempt("Read", "t1", { rejected: false }))),
  ).toThrow(/隔離/);
  // 中止の理由に**何が動いたか**を書く（名前だけ。本文は載せない, A1-5）
  expect(() =>
    readResult(ok({ num_turns: 2 }, toolAttempt("Read", "t1", { rejected: false }))),
  ).toThrow(/ran=Read/);
  // サーバ側ツールが実際に走った
  expect(() => readResult(ok({ usage: { server_tool_use: { web_search_requests: 1 } } }))).toThrow(
    /隔離/,
  );
});

/**
 * **「試みて弾かれた」は、破れていない。** この間違いは二度起きている。
 *
 * 一度目は `permission_denials` があるだけで中止していた。二度目は、CLI が塞ぎ方を
 * 変えて——弾いた道具を `permission_denials` ではなく `tool_result` の `is_error` で
 * 返すようになり——`num_turns > 1 && 拒否0件` という**代理指標**がそれを「破れた」と読んだ。
 *
 * 実測（Bob の本番ログより）:
 * ```
 * tool_use    name=Bash
 * tool_result is_error=true :: No such tool available: Bash. Bash is disabled…
 * → num_turns=2 / permission_denials=[] → 「隔離が破れています」
 * ```
 * 隔離は完璧に働いていたのに、**利用者には毎回「うまく応答できませんでした」**と見えていた。
 */
test("**弾かれた試行を、破れたと読まない**（隔離が働いた証拠である）", () => {
  // CLI が塞いだ形。ターンは増えるが、副作用は起きていない
  const blocked = ok({ num_turns: 2 }, toolAttempt("Bash", "t1", { rejected: true }));
  expect(readResult(blocked)).toBe("こんにちは。");

  // 旧経路（permission_denials に載る版）でも同じく答えを使う
  expect(readResult(ok({ num_turns: 3, permission_denials: [{ tool_name: "WebSearch" }] }))).toBe(
    "こんにちは。",
  );
});

/**
 * Russell 自身の道具名を、CLI のネイティブなツール呼び出しとして出してくることがある
 * （調べものの約束は「JSON で返す」だが、CLI の中ではツール機構が使えてしまう）。
 * CLI にその名前は無いので弾かれる——**これも破れてはいない**。
 */
test("**持っていない道具を呼んでも、破れたことにしない**", () => {
  const stream = ok({ num_turns: 2 }, toolAttempt("notion.read_page", "t1", { rejected: true }));
  expect(readResult(stream)).toBe("こんにちは。");
});

test("弾かれたものと動いたものが混ざれば、中止する", () => {
  // 片方が弾かれても、もう片方が**実際に動いていれば**副作用は起きている
  const stream = ok(
    { num_turns: 3 },
    toolAttempt("Bash", "t1", { rejected: true }) +
      toolAttempt("Monitor", "t2", { rejected: false }),
  );
  expect(() => readResult(stream)).toThrow(/隔離/);
  expect(() => readResult(stream)).toThrow(/ran=Monitor/);
});

test("**結果が読めない道具は、動いた扱いにする**（fail-closed）", () => {
  // tool_use だけあって tool_result が無い。分からないものを「弾かれた」に倒すと、
  // 破れているのに通してしまう。逆に倒せば黙るだけで済む
  const stream = ok(
    { num_turns: 2 },
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read" }] },
    }),
  );
  expect(() => readResult(stream)).toThrow(/隔離/);
});

test("拒否されても、サーバ側ツールが走っていれば中止する", () => {
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
  // **終端が読めないものは通さない。** 何が起きたか分からないまま返事をさせない
  expect(() => readResult("not json")).toThrow(/result/);
  expect(() => readResult(line({ type: "system", subtype: "init" }))).toThrow(/result/);
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

/**
 * 中止するときは、**何を見てそう言ったのか**を残す。
 *
 * これが無くて、毎回1通目で中止しているのに原因を追えなかった。
 * 「隔離が破れています」とだけ言われても、本当に道具が動いたのか、
 * 弾かれただけなのかが分からない。
 *
 * いまは**名前まで**残す。数だけでは、次に同じことが起きたときに
 * また CLI のトランスクリプトを掘り返すことになる。
 */

test("**中止の理由に、何が動いて何が弾かれたかを書く**（本文は入れない）", () => {
  try {
    readResult(
      ok(
        { num_turns: 4 },
        toolAttempt("Monitor", "t1", { rejected: false }) +
          toolAttempt("Bash", "t2", { rejected: true }),
      ),
    );
    throw new Error("throw されるはず");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // **動いたものと弾かれたものを分けて書く**（対処が違う）
    expect(message).toContain("ran=Monitor");
    expect(message).toContain("blocked=Bash");
    expect(message).toContain("num_turns=4");
    expect(message).toContain("web_search=0");
    // 本文は載せない（A1-5）
    expect(message).not.toContain("こんにちは");
  }
});
