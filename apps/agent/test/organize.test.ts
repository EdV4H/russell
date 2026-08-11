/**
 * 本棚の整理（§4-3）。env 不要な部分（計画の解釈と検証）をここで固める。
 *
 * この経路は **untrusted なテキストを読んだモデルの出力で DB を書き換える**（§12-3）ので、
 * 「モデルが返した id をそのまま使わない」ことがいちばん大事な性質になる。
 */

import {
  type OrganizePlan,
  type ShelfBook,
  buildOrganizePrompt,
  isEmptyPlan,
  parseOrganizePlan,
  validatePlan,
} from "@edv4h/russell-plugin-memory-pg";
import { expect, test } from "vitest";

const BOOKS: ShelfBook[] = [
  { id: 1, title: "役割の期待", card: "広く浅く答えて詳しい人へ繋ぐハブ役", strength: 0.8 },
  {
    id: 2,
    title: "丸山さんは私に「広く浅",
    card: "ハブ役を期待。主要ツールは Slack と Notion",
    strength: 1.0,
  },
  { id: 3, title: "定例の時間", card: "定例は金曜15時から", strength: 0.5 },
];

const plan = (json: string) => validatePlan(parseOrganizePlan(json), BOOKS);

test("重複を畳む計画を読む", () => {
  const p = plan(
    '{"merges":[{"keep":1,"absorb":[2],"title":"期待される役割","card":"まとめ"}],"retitles":[]}',
  );

  expect(p.merges).toEqual([{ keep: 1, absorb: [2], title: "期待される役割", card: "まとめ" }]);
  expect(p.retitles).toEqual([]);
});

test("見出しの付け直しを読む", () => {
  const p = plan('{"merges":[],"retitles":[{"id":2,"title":"期待される役割と主要ツール"}]}');
  expect(p.retitles).toEqual([{ id: 2, title: "期待される役割と主要ツール" }]);
});

test("読めない出力なら何もしない（fail-safe）", () => {
  for (const broken of ["これは JSON ではない", "", '{"merges":', "{}", "null"]) {
    expect(isEmptyPlan(plan(broken))).toBe(true);
  }
});

test("本棚に無い id は落とす（モデルの id を信用しない）", () => {
  const p = plan(
    '{"merges":[{"keep":99,"absorb":[1],"title":"x","card":"y"}],"retitles":[{"id":98,"title":"z"}]}',
  );
  expect(isEmptyPlan(p)).toBe(true);
});

test("存在しない吸収先が混ざっていても、実在するものだけで畳む", () => {
  const p = plan('{"merges":[{"keep":1,"absorb":[2,99],"title":"x","card":"y"}],"retitles":[]}');
  expect(p.merges[0]?.absorb).toEqual([2]);
});

test("自分自身は吸収しない", () => {
  const p = plan('{"merges":[{"keep":1,"absorb":[1],"title":"x","card":"y"}],"retitles":[]}');
  expect(isEmptyPlan(p)).toBe(true);
});

test("同じ本を2つの計画で取り合わない（先に来た方だけ通す）", () => {
  const p = plan(
    '{"merges":[{"keep":1,"absorb":[2],"title":"x","card":"y"},{"keep":3,"absorb":[2],"title":"z","card":"w"}],"retitles":[{"id":1,"title":"別の見出し"}]}',
  );

  expect(p.merges).toHaveLength(1);
  expect(p.merges[0]?.keep).toBe(1);
  // 畳む対象の見出しは merge が決めるので、retitle 側は触らない
  expect(p.retitles).toEqual([]);
});

test("変わらない見出しは書き直さない", () => {
  const p = plan('{"merges":[],"retitles":[{"id":3,"title":"定例の時間"}]}');
  expect(p.retitles).toEqual([]);
});

test("長すぎる見出しとカードは切り詰める", () => {
  const long = "あ".repeat(1000);
  const p = plan(
    `{"merges":[{"keep":1,"absorb":[2],"title":"${long}","card":"${long}"}],"retitles":[]}`,
  );

  expect(p.merges[0]?.title.length).toBe(60);
  expect(p.merges[0]?.card.length).toBe(600);
});

test("カードが無い畳み方は採らない（内容を失う）", () => {
  const p = plan('{"merges":[{"keep":1,"absorb":[2],"title":"見出しだけ"}],"retitles":[]}');
  expect(isEmptyPlan(p)).toBe(true);
});

test("プロンプトには id と本文が並び、判断の基準が入っている", () => {
  const { system, user } = buildOrganizePrompt(BOOKS);

  expect(user).toContain("id=1");
  expect(user).toContain("広く浅く答えて詳しい人へ繋ぐハブ役");
  expect(system).toContain("迷ったらまとめない");
  // 情報を落とさないことを明示しておく（畳む操作の一番の危険）
  expect(system).toContain("落とさずに");
});

test("空の計画は空と判定する", () => {
  const empty: OrganizePlan = { merges: [], retitles: [] };
  expect(isEmptyPlan(empty)).toBe(true);
});
