/**
 * 日報の投稿先を Slack から変える（`/russell journal here`）。env 不要。
 *
 * env に置かない理由: 変えるたびに再起動が要り、**誰がいつ変えたか残らない**。
 * 設計は運用設定を config 側に置き、変更履歴を event_log へ残すと定めている（§6.1）。
 *
 * 権限で縛らない代わりに、**黙って変えられない**形にしてある。ここで固めたいのはそれ。
 */

import {
  JOURNAL_CHANNEL_SETTING,
  parseRussellCommand,
  runRussellCommand,
} from "@edv4h/russell-plugin-surface-slack";
import type { SettingsCapability } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

function fakeSettings(initial?: string) {
  const store = new Map<string, string | null>();
  if (initial) store.set(JOURNAL_CHANNEL_SETTING, initial);
  const changes: { key: string; value: string | null; by: string }[] = [];
  const capability: SettingsCapability = {
    async get(key) {
      return store.get(key) ?? undefined;
    },
    async set(key, value, updatedBy) {
      const before = store.get(key) ?? undefined;
      store.set(key, value);
      changes.push({ key, value, by: updatedBy });
      return { before };
    },
  };
  return { capability, changes, store };
}

const deps = (settings?: SettingsCapability, channelId = "C_HERE") => ({
  selfAgentId: "bob",
  isOperator: () => false, // **権限者でなくても通る**のがこの機能の要点
  settings,
  channelId,
});

test("打ったチャンネルだけを指定できる（任意の宛先を渡せない）", () => {
  expect(parseRussellCommand("journal here", "bob")).toEqual({ kind: "journal", action: "here" });
  expect(parseRussellCommand("journal off", "bob")).toEqual({ kind: "journal", action: "off" });
  // チャンネル ID を渡そうとしても使い方が返るだけ
  expect(parseRussellCommand("journal C_OTHER", "bob").kind).toBe("help");
});

test("設定でき、権限者でなくても通る", async () => {
  const s = fakeSettings();
  const result = await runRussellCommand("journal here", "U1", deps(s.capability));

  expect(s.changes).toEqual([{ key: JOURNAL_CHANNEL_SETTING, value: "C_HERE", by: "U1" }]);
  expect(result.reply).toContain("このチャンネル");
});

test("黙って変えられない: 新しい投稿先に宣言が出る", async () => {
  const result = await runRussellCommand("journal here", "U1", deps(fakeSettings().capability));

  // ephemeral の返答とは別に、チャンネル全員に見える宣言が出る
  expect(result.declare).toContain("このチャンネルに出します");
  expect(result.declare).toContain("<@U1>");
});

test("黙って変えられない: 管理チャンネルにも流れる（変更前後が分かる）", async () => {
  const s = fakeSettings("C_OLD");
  const result = await runRussellCommand("journal here", "U1", deps(s.capability));

  expect(result.announce).toContain("<#C_OLD>");
  expect(result.announce).toContain("<#C_HERE>");
  expect(result.announce).toContain("<@U1>");
});

test("止めるときも記録が残る", async () => {
  const s = fakeSettings("C_OLD");
  const result = await runRussellCommand("journal off", "U1", deps(s.capability));

  expect(s.store.get(JOURNAL_CHANNEL_SETTING)).toBeNull();
  expect(result.announce).toContain("停止");
  // 日記そのものは書かれ続けることを伝える（記録と公開は別）
  expect(result.reply).toContain("日記そのものは");
});

test("同じチャンネルで2回打っても宣言を繰り返さない", async () => {
  const s = fakeSettings("C_HERE");
  const result = await runRussellCommand("journal here", "U1", deps(s.capability));

  expect(result.declare).toBeUndefined();
  expect(result.reply).toContain("すでに");
});

test("設定を持たない構成では、その旨を返す", async () => {
  const result = await runRussellCommand("journal here", "U1", deps(undefined));
  expect(result.reply).toContain("運用設定");
});

test("DM に設定できるが、公開されないことを必ず伝える", async () => {
  const s = fakeSettings();
  const result = await runRussellCommand("journal here", "U1", deps(s.capability, "D_DM"));

  // 禁止はしない（「まず自分だけで数日読む」は正当な使い方）
  expect(s.store.get(JOURNAL_CHANNEL_SETTING)).toBe("D_DM");
  // **建前から外れていることは必ず言う**
  expect(result.reply).toContain("あなたにしか見えません");
  expect(result.reply).toContain("チームに公開する前提");
  // 管理チャンネルにも「DM である」と分かる形で流れる
  expect(result.announce).toContain("DM");
  expect(result.announce).toContain("公開されません");
});

test("通常のチャンネルでは DM の注意書きは出ない", async () => {
  const result = await runRussellCommand(
    "journal here",
    "U1",
    deps(fakeSettings().capability, "C_TEAM"),
  );

  expect(result.reply).not.toContain("あなたにしか見えません");
  expect(result.announce).toContain("<#C_TEAM>");
});
