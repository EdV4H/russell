/**
 * 日報の配信（§10.1）。env 不要。
 *
 * 宛先は1つとは限らない。想定は3つで、どれも「段の並び」で表せる:
 * Slack に投稿 / Notion に投稿 / **Notion に書いてその URL を Slack で周知**。
 * 3つ目だけが構造として新しい（前段の出力を後段が使う）。
 *
 * ここで固めたいのは順序・依存・冪等の3つ。**二重投稿は取り消せない**ので、
 * 「分からないときは投げない」に倒っていることを確かめる。
 */

import { type PublishStep, type StepReport, runPublication } from "@edv4h/russell-core";
import type { OperationResult } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const base = { entryDate: "2026-08-11", narrative: "今日はこういう一日だった。" };

/** 決まった結果を返す段。呼ばれた回数と、渡された文脈を記録する。 */
function step(
  id: string,
  status: OperationResult = "succeeded",
  output?: string,
): PublishStep & { calls: { outputs: Record<string, string> }[] } {
  const calls: { outputs: Record<string, string> }[] = [];
  return {
    id,
    calls,
    async deliver(ctx) {
      calls.push({ outputs: { ...ctx.outputs } });
      return { status, output };
    },
  };
}

const byId = (reports: StepReport[], id: string) => reports.find((r) => r.stepId === id);

test("段を順に実行する", async () => {
  const a = step("notion");
  const b = step("slack");
  const reports = await runPublication([a, b], base);

  expect(reports.map((r) => r.stepId)).toEqual(["notion", "slack"]);
  expect(reports.every((r) => r.status === "succeeded")).toBe(true);
});

test("前段の出力を後段が使える（Notion の URL を Slack で周知）", async () => {
  const notion = step("notion", "succeeded", "https://notion.so/page-1");
  const slack = step("slack");
  await runPublication([notion, slack], base);

  expect(slack.calls[0]?.outputs).toEqual({ notion: "https://notion.so/page-1" });
});

test("前段が失敗したら後段を走らせない（書けていないのに周知しない）", async () => {
  const notion = step("notion", "rejected");
  const slack = step("slack");
  const reports = await runPublication([notion, slack], base);

  expect(slack.calls).toHaveLength(0);
  expect(byId(reports, "slack")).toMatchObject({ status: "skipped", reason: "upstream_failed" });
});

test("前段が unknown でも後段を走らせない", async () => {
  const notion = step("notion", "unknown");
  const slack = step("slack");
  await runPublication([notion, slack], base);

  expect(slack.calls).toHaveLength(0);
});

test("例外は unknown に倒す（成功したかもしれないので rejected とは言えない）", async () => {
  const broken: PublishStep = {
    id: "slack",
    async deliver() {
      throw new Error("ECONNRESET");
    },
  };
  const reports = await runPublication([broken], base);

  expect(byId(reports, "slack")).toMatchObject({ status: "unknown", detail: "ECONNRESET" });
});

test("既に成功している段は飛ばす（日付キーで再実行できる）", async () => {
  const slack = step("slack");
  const reports = await runPublication([slack], base, {
    prior: async () => "succeeded",
  });

  expect(slack.calls).toHaveLength(0);
  expect(byId(reports, "slack")).toMatchObject({ status: "skipped", reason: "already_published" });
});

test("前回が unknown なら投げ直さない（blind retry の禁止, §9.2）", async () => {
  const slack = step("slack");
  const reports = await runPublication([slack], base, {
    prior: async () => "unknown",
  });

  // **二重投稿は取り消せない。** 人が確認するまで自動では解決しない
  expect(slack.calls).toHaveLength(0);
  expect(byId(reports, "slack")).toMatchObject({ status: "skipped", reason: "prior_unknown" });
});

test("前回が rejected なら投げ直す（結果が分かっているので安全）", async () => {
  const slack = step("slack");
  await runPublication([slack], base, { prior: async () => "rejected" });

  expect(slack.calls).toHaveLength(1);
});

test("実行した段だけ記録する（飛ばした段は記録しない）", async () => {
  const recorded: string[] = [];
  const done = step("notion");
  const skipped = step("slack");
  await runPublication([done, skipped], base, {
    prior: async (id) => (id === "slack" ? "succeeded" : undefined),
    record: async (id) => {
      recorded.push(id);
    },
  });

  expect(recorded).toEqual(["notion"]);
});

test("段には日報の中身が渡る", async () => {
  const seen: string[] = [];
  const s: PublishStep = {
    id: "slack",
    async deliver(ctx) {
      seen.push(`${ctx.entryDate}|${ctx.narrative}`);
      return { status: "succeeded" };
    },
  };
  await runPublication([s], base);

  expect(seen[0]).toBe("2026-08-11|今日はこういう一日だった。");
});

test("段の構築で落ちるのと、送信で落ちるのは別（前者は再送できる）", async () => {
  // 構築時の失敗は「送る前に落ちた」＝確実に届いていない。unknown にすると
  // blind retry 禁止に引っかかって**二度と配信できなくなる**（実際そうなった）
  const built: PublishStep = {
    id: "slack",
    async deliver() {
      return { status: "rejected", detail: "設定が足りない" };
    },
  };
  const reports = await runPublication([built], base);

  expect(reports[0]).toMatchObject({ status: "rejected" });
  // rejected なら次回は投げ直せる
  const retried = step("slack");
  await runPublication([retried], base, { prior: async () => "rejected" });
  expect(retried.calls).toHaveLength(1);
});
