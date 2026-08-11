/**
 * 機微情報ガード（A-1）。env 不要。
 * 仕様: `docs/preparation/governance/sensitive-info-guard.md` §2「ガードのテスト方法」。
 *
 * 仕様は**検知漏れと過剰保留の両方**を測れと言っている。片方だけ良くするのは簡単で、
 * 全部止めれば漏れはゼロになり、何も止めなければ過剰保留はゼロになるので。
 *
 * このテストは合否だけでなく**数値を出力する**。リストを更新したときに、
 * どちらへ動いたかが見えるようにするため。
 */

import {
  type SensitiveCategory,
  UNDETECTABLE_CATEGORIES,
  inspectSensitive,
} from "@edv4h/russell-core";
import { expect, test } from "vitest";

/**
 * レッドチーム・コーパス: 止まってほしいもの（カテゴリ付き）。
 *
 * **値はすべて架空。** 実際に見た機微情報をテストに書くと、ガードのテストそのものが
 * 漏洩経路になる（リポジトリは公開される）。ここに実物を貼らないこと。
 */
const RED: { text: string; category: SensitiveCategory }[] = [
  // 認証情報
  { text: "Slack のトークンは xoxb-1234567890-abcdefg です", category: "credentials" },
  { text: "NOTION_TOKEN=ntn_abcdef1234567890 を設定した", category: "credentials" },
  { text: "api_key: sk-ant-api03-xxxxxxxxxxxx を共有します", category: "credentials" },
  { text: "パスワードは Hunter2Hunter2 でログインできます", category: "credentials" },
  // 給与
  { text: "田中さんの年収は900万円で、今期の査定はAでした", category: "salary" },
  { text: "来期から等級が上がってボーナスも増えるらしい", category: "salary" },
  // 未公開の経営・財務
  { text: "来月 M&A の発表がある。まだ未公表なので注意", category: "confidential_biz" },
  { text: "7月予算：¥12,345,678 に対して着地見込みは900万", category: "confidential_biz" },
  { text: "シリーズCの資金調達を検討中", category: "confidential_biz" },
  // 健康
  { text: "佐藤さんは来月から休職するそうです", category: "health" },
  { text: "山田さんが通院のため午後は不在", category: "health" },
  { text: "健康診断の結果を提出した", category: "health" },
  { text: "うつ病と診断されたそうです", category: "health" },
  // 人事
  { text: "鈴木さんの異動が内定した", category: "hr" },
  { text: "採用選考で3名が最終面接に進んだ", category: "hr" },
  // 懲戒
  { text: "先月のハラスメント事案の処分が決まった", category: "disciplinary" },
  // センシティブ属性
  { text: "彼の国籍と宗教について話題になった", category: "sensitive_attributes" },
  // 顧客の秘密
  { text: "A社との契約条件はNDAの対象です", category: "customer_secret" },
  { text: "B社は解約検討に入っている", category: "customer_secret" },
  // 法的係争
  { text: "訴訟の件で弁護士と相談した", category: "legal_dispute" },
];

/** ゴールデンセット: 止まってほしくないもの（仕様 §1「書いてよいもの」）。 */
const GREEN: string[] = [
  "Aの仕様が決まった。金曜までに実装する",
  "Bのレビューを終えた。指摘は2件",
  "定例は毎週金曜15時から",
  "ドキュメントは Notion にまとめる方針になった",
  "デプロイは来週の火曜に行う",
  "議事録のテンプレートを更新した",
  "チームの主要ツールは Slack と GitHub",
  "新しいプラグインの設計を相談した",
  "テストが3件落ちていたので直した",
  "来週のワークショップの進行を担当する",
  // 実際に誤検知した文言。**業務語としての「診断」**は普通に出てくる
  "構成要素は Profile / Chat / ValuesCard / Session / Canvas / 特性診断",
  "性格診断の結果をチームで共有した",
  "エンゲージメント診断のスコアを見た",
  "自己診断シートのテンプレートを作った",
];

test("レッドチーム・コーパス: 検知漏れを測る", () => {
  const missed = RED.filter((c) => !inspectSensitive(c.text).hit);
  const wrongCategory = RED.filter((c) => {
    const r = inspectSensitive(c.text);
    return r.hit && !r.categories.includes(c.category);
  });

  console.log(
    `[ガード] 検知漏れ ${missed.length}/${RED.length}` +
      `（カテゴリ違い ${wrongCategory.length}件）`,
  );
  for (const m of missed) console.log(`  漏れ: ${m.category} / ${m.text.slice(0, 30)}`);

  // 全公開設計なので漏れは実損に直結する。既知コーパス上はゼロを維持する
  expect(missed).toEqual([]);
  expect(wrongCategory).toEqual([]);
});

test("ゴールデンセット: 過剰保留を測る", () => {
  const blocked = GREEN.filter((t) => inspectSensitive(t).hit);

  console.log(`[ガード] 過剰保留 ${blocked.length}/${GREEN.length}`);
  for (const b of blocked) {
    console.log(`  過剰: ${inspectSensitive(b).categories} / ${b.slice(0, 30)}`);
  }

  // 業務の記録が軒並み保留されると、日報が実質空になる（degradation）
  expect(blocked).toEqual([]);
});

test("捕まえられないカテゴリを明示する（止まっているつもりにならない）", () => {
  // 「人物評価」は語彙で決まらない。実際すり抜けることをテストで固定しておく
  const evaluations = [
    "Xさんは詰めが甘いところがある",
    "Yさんは頼りになるので任せて大丈夫",
    "Zさんはあまり手が早くない",
  ];
  for (const text of evaluations) {
    expect(inspectSensitive(text).hit).toBe(false);
  }

  // 型の側でも見えるようにしてある
  expect(UNDETECTABLE_CATEGORIES).toContain("personal_evaluation");
  expect(UNDETECTABLE_CATEGORIES).toContain("negative_naming");
});

test("balanced では弱い規則が効かない", () => {
  const amount = "7月の予算は¥12,345,678でした";

  expect(inspectSensitive(amount, { strictness: "conservative" }).hit).toBe(true);
  expect(inspectSensitive(amount, { strictness: "balanced" }).hit).toBe(false);
  // 明確なものは balanced でも止まる
  expect(inspectSensitive("年収900万円", { strictness: "balanced" }).hit).toBe(true);
});

test("カテゴリを個別に切れる", () => {
  const text = "佐藤さんは来月から休職するそうです";

  expect(inspectSensitive(text).categories).toContain("health");
  expect(inspectSensitive(text, { categories: { health: false } }).categories).not.toContain(
    "health",
  );
});

test("結果に本文を含めない（監査へそのまま載せられる, A1-5）", () => {
  const result = inspectSensitive("Slack のトークンは xoxb-1234567890-abcdefg です");

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("xoxb-");
  expect(serialized).not.toContain("トークン");
  expect(result.categories).toEqual(["credentials"]);
});

test("空文字・空白では何も当たらない", () => {
  expect(inspectSensitive("").hit).toBe(false);
  expect(inspectSensitive("   \n  ").hit).toBe(false);
});
