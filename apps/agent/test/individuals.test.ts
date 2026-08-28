/**
 * どの個体を立ち上げるか（§8）。env 不要。
 *
 * 組み立てホストは長らく1体決め打ちだった。2人目を置くにあたって危ないのは、
 * **別の個体のつもりで既存の記憶へ書き込む**ことである。記憶は `agent_id` で
 * 分かれているので、id を取り違えると後から分離できない。
 */

import { resolveIndividual, secretFor } from "@edv4h/russell-agent/individuals";
import { expect, test } from "vitest";

test("既定は個体1号（今までどおり動く）", () => {
  expect(resolveIndividual(undefined).id).toBe("bob");
  expect(resolveIndividual("bob").temperament.name).toBe("Bob");
  // 大文字小文字と前後の空白は許す（env は人が書く）
  expect(resolveIndividual(" BOB ").id).toBe("bob");
});

test("**知らない名前は落とす**（既定へ倒さない）", () => {
  // 倒すと「2号のつもりで Bob の記憶へ書く」が起きる。後から分離できない
  expect(() => resolveIndividual("hana")).toThrow(/知らない個体/);
  expect(() => resolveIndividual("bobb")).toThrow(/知らない個体/);
});

test("鍵は個体ごとに読む。**無ければ接尾辞なしへ落ちる**", () => {
  const bob = resolveIndividual("bob");
  const saved = { ...process.env };
  try {
    process.env.SLACK_BOT_TOKEN = "共通";
    process.env.SLACK_BOT_TOKEN_BOB = "ボブ専用";
    expect(secretFor("SLACK_BOT_TOKEN", bob)).toBe("ボブ専用");

    // 1体だけで動かしている間は今までの env がそのまま効く（動いているものを壊さない）
    process.env.SLACK_BOT_TOKEN_BOB = undefined as unknown as string;
    // biome-ignore lint/performance/noDelete: env から本当に消す必要がある
    delete process.env.SLACK_BOT_TOKEN_BOB;
    expect(secretFor("SLACK_BOT_TOKEN", bob)).toBe("共通");
  } finally {
    process.env = saved;
  }
});

test("鍵が無ければ undefined（空文字を鍵として扱わない）", () => {
  const bob = resolveIndividual("bob");
  const saved = { ...process.env };
  try {
    // biome-ignore lint/performance/noDelete: env から本当に消す必要がある
    delete process.env.SLACK_BOT_TOKEN;
    // biome-ignore lint/performance/noDelete: env から本当に消す必要がある
    delete process.env.SLACK_BOT_TOKEN_BOB;
    expect(secretFor("SLACK_BOT_TOKEN", bob)).toBeUndefined();
  } finally {
    process.env = saved;
  }
});
