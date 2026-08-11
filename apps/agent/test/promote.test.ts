/**
 * メモから本棚への昇格（§4-3 / ADR 0005）。env 不要な部分をここで固める。
 *
 * 直したい問題は**粒度**だった。会話中に note と shelf を同時に書かせると、同じ1往復を
 * 2回要約することになり、メモと本が同じ大きさになる。「3件以上のメモに現れた話題だけ」を
 * 通す検証が、その担保そのものになっている。
 */

import {
  MIN_NOTES_FOR_PROMOTION,
  type PromotableNote,
  buildPromotionPrompt,
  parsePromotions,
  validatePromotions,
} from "@edv4h/russell-plugin-memory-pg";
import { expect, test } from "vitest";

const NOTES: PromotableNote[] = [
  { id: 1, content: "丸山さんはハブ役を期待している" },
  { id: 2, content: "情報源は Slack・Notion・GitHub・Drive" },
  { id: 3, content: "アウトプットは軽い共有が Slack、重い内容が Notion" },
  { id: 4, content: "今日17時までに返信する" },
];

const plan = (json: string, notes = NOTES) => validatePromotions(parsePromotions(json), notes);

const promotion = (ids: number[]) =>
  `{"promotions":[{"note_ids":${JSON.stringify(ids)},"title":"期待される役割","card":"まとめ"}]}`;

test("3件以上のメモに現れた話題を1冊にする", () => {
  const p = plan(promotion([1, 2, 3]));

  expect(p).toHaveLength(1);
  expect(p[0]?.noteIds).toEqual([1, 2, 3]);
  expect(p[0]?.title).toBe("期待される役割");
});

test("2件では昇格しない（粒度がメモに戻るため）", () => {
  expect(plan(promotion([1, 2]))).toEqual([]);
  expect(MIN_NOTES_FOR_PROMOTION).toBe(3);
});

test("読めない出力なら昇格しない（fail-safe）", () => {
  for (const broken of ["これは JSON ではない", "", '{"promotions":', "{}", "null"]) {
    expect(plan(broken)).toEqual([]);
  }
});

test("渡していないメモの id は落とす（モデルの id を信用しない）", () => {
  // 99 は候補に無い。残るのは3件未満になるので昇格そのものが消える
  expect(plan(promotion([1, 2, 99]))).toEqual([]);
  expect(plan(promotion([1, 2, 3, 99]))[0]?.noteIds).toEqual([1, 2, 3]);
});

test("同じメモを2冊の材料にしない", () => {
  const p = plan(
    '{"promotions":[' +
      '{"note_ids":[1,2,3],"title":"A","card":"a"},' +
      '{"note_ids":[1,2,3,4],"title":"B","card":"b"}]}',
  );

  expect(p).toHaveLength(1);
  expect(p[0]?.title).toBe("A");
});

test("重複した id は1回だけ数える（水増しで昇格させない）", () => {
  expect(plan(promotion([1, 1, 1]))).toEqual([]);
});

test("見出しか本文が欠けている昇格は採らない", () => {
  expect(plan('{"promotions":[{"note_ids":[1,2,3],"title":"見出しだけ"}]}')).toEqual([]);
  expect(plan('{"promotions":[{"note_ids":[1,2,3],"card":"本文だけ"}]}')).toEqual([]);
});

test("しきい値は呼び出し側で変えられる", () => {
  expect(validatePromotions(parsePromotions(promotion([1, 2])), NOTES, 2)).toHaveLength(1);
});

test("プロンプトは1回きりの出来事を除くよう指示している", () => {
  const { system, user } = buildPromotionPrompt(NOTES);

  expect(user).toContain("id=4: 今日17時までに返信する");
  expect(system).toContain("1回きりの出来事は昇格させない");
  expect(system).toContain("メモの言い換えにしない"); // 粒度が上がらないと意味がない
  expect(system).toContain("3件以上");
});
