/**
 * `/russell` スラッシュコマンドの解釈と実行（Slack 接続不要）。§12-4 レベル1/2。
 *
 * 検証すること:
 * 1. 曖昧な入力は「自分を止める」に倒れる（発動したつもりで何も止まらない、を作らない）
 * 2. 発動は誰でもできる／解除は権限者だけ（未設定なら誰も解除できない = fail-closed）
 * 3. 発動記録が管理チャンネル向けに出る（kill-switch.md 連絡フロー）
 */

import {
  operatorCheckFromEnv,
  parseRussellCommand,
  runRussellCommand,
} from "@edv4h/russell-plugin-surface-slack";
import type { KillSwitchCapability, StopInput, StopState } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const RUNNING: StopState = { stopped: false, scope: null, by: null, at: null, reason: null };

function fakeCapability() {
  const calls: StopInput[] = [];
  const resumed: Omit<StopInput, "reason">[] = [];
  const capability: KillSwitchCapability = {
    async current() {
      return RUNNING;
    },
    async stop(input) {
      calls.push(input);
      return {
        stopped: true,
        scope: input.scope,
        by: input.by,
        at: "2026-08-05T00:00:00.000Z",
        reason: input.reason ?? null,
      };
    },
    async resume(input) {
      resumed.push(input);
      return RUNNING;
    },
  };
  return { capability, calls, resumed };
}

test("stop の引数: --all / --agent / 自分の名前 / 理由", () => {
  expect(parseRussellCommand("stop", "bob")).toEqual({
    kind: "stop",
    scope: "agent",
    agentId: "bob",
    reason: undefined,
  });
  expect(parseRussellCommand("stop --all", "bob")).toMatchObject({ kind: "stop", scope: "all" });
  expect(parseRussellCommand("stop --agent=alice", "bob")).toMatchObject({
    kind: "stop",
    scope: "agent",
    agentId: "alice",
  });
  // 個体名が自分と一致するときだけ「個体指定」として食べる（`/russell stop bob`）
  expect(parseRussellCommand("stop bob 誤送信が続いている", "bob")).toEqual({
    kind: "stop",
    scope: "agent",
    agentId: "bob",
    reason: "誤送信が続いている",
  });
});

test("個体名か理由か曖昧なときは理由として扱い、自分を止める", () => {
  // `spam` を個体名と読むと「spam を止めた」ことになり、暴走中の個体は動いたまま残る
  const cmd = parseRussellCommand("stop spam", "bob");
  expect(cmd).toEqual({ kind: "stop", scope: "agent", agentId: "bob", reason: "spam" });
});

test("不正な入力は実行せず使い方を返す", () => {
  expect(parseRussellCommand("stop --force", "bob").kind).toBe("help");
  expect(parseRussellCommand("stop --agent=../etc/passwd", "bob").kind).toBe("help");
  expect(parseRussellCommand("stop --all --agent=alice", "bob").kind).toBe("help");
  expect(parseRussellCommand("", "bob").kind).toBe("help");
  expect(parseRussellCommand("しばらく黙って", "bob").kind).toBe("help");
});

test("発動は誰でもできる（承認は要らない）", async () => {
  const f = fakeCapability();
  const result = await runRussellCommand("stop 誤送信", "u-anyone", {
    capability: f.capability,
    selfAgentId: "bob",
    isOperator: () => false, // 権限者でなくても止められる
  });

  expect(f.calls).toEqual([{ agentId: "bob", scope: "agent", by: "u-anyone", reason: "誤送信" }]);
  expect(result.reply).toContain("凍結しました");
  expect(result.announce).toContain("キルスイッチ発動");
});

test("解除は権限者だけ（権限者未設定なら誰も解除できない）", async () => {
  const f = fakeCapability();
  const denied = await runRussellCommand("start", "u-anyone", {
    capability: f.capability,
    selfAgentId: "bob",
    isOperator: operatorCheckFromEnv(""), // RUSSELL_KILL_OPERATORS 未設定
  });
  expect(denied.reply).toContain("権限者のみ");
  expect(denied.announce).toBeUndefined();
  expect(f.resumed).toEqual([]);

  const allowed = await runRussellCommand("start", "u-ops", {
    capability: f.capability,
    selfAgentId: "bob",
    isOperator: operatorCheckFromEnv("u-ops, u-owner"),
  });
  expect(allowed.reply).toContain("解除しました");
  expect(f.resumed).toEqual([{ agentId: "bob", scope: "agent", by: "u-ops" }]);
});

test("通常経路を持たない構成では別経路（env）を案内する", async () => {
  const result = await runRussellCommand("stop", "u-anyone", {
    capability: undefined,
    selfAgentId: "bob",
    isOperator: () => true,
  });
  expect(result.reply).toContain("RUSSELL_KILL");
  expect(result.announce).toBeUndefined();
});
