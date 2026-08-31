/**
 * どの個体を立ち上げるか（§8）。env 不要。
 *
 * 組み立てホストは長らく1体決め打ちだった。2人目を置くにあたって危ないのは、
 * **別の個体のつもりで既存の記憶へ書き込む**ことである。記憶は `agent_id` で
 * 分かれているので、id を取り違えると後から分離できない。
 */

import { INDIVIDUALS, resolveIndividual, secretFor } from "@edv4h/russell-agent/individuals";
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

/**
 * 装備は個体ごと（§9.1）。
 *
 * プリセットにも `equipment` という軸が最初からある（番頭は `["slack"]` だけ）。
 * 秘書に会議の装備は要らないし、逆にカレンダーは新人には要らない。
 */

test("個体は自分に支給された装備だけを持つ", () => {
  const bob = resolveIndividual("bob");

  // いまの Bob が持っているものがそのまま載っている（挙動を変えていない）
  expect(bob.equipment).toContain("google-drive");
  expect(bob.equipment).toContain("meeting");
});

test("**支給されていない装備は、存在すら知らない**（§9.2）", () => {
  const bob = resolveIndividual("bob");
  // 「持っているが使わせない」ではなく「持っていない」。載っていないものは組み立てない
  expect(bob.equipment).not.toContain("calendar" as never);
});

/**
 * 個体2号 Walter（番頭）。
 *
 * 名前は Alice and Bob の一覧から取る。順番が決まっていて名付けで悩まないのが主な理由だが、
 * **あの一覧には敵役がいる**（Eve は盗聴者、Mallory は攻撃者、Trudy は侵入者）。
 * 個体の名前に使うと、監査ログにその名前が並ぶことになる。
 */

test("2号は 1号とは別の個体として立つ", () => {
  const walter = resolveIndividual("walter");

  expect(walter.id).toBe("walter");
  expect(walter.temperament.name).toBe("Walter");
  // 記憶は agent_id で分かれる。**id が違うことが分離の根拠**である
  expect(walter.id).not.toBe(resolveIndividual("bob").id);
});

test("**鍵は個体ごとに分かれる**（同じものを共有しない）", () => {
  const key = "SLACK_APP_TOKEN";
  const saved = { ...process.env };
  try {
    process.env[`${key}_BOB`] = "1号の分";
    process.env[`${key}_WALTER`] = "2号の分";

    // 共有すると、2つの個体が同じ名前で喋り、どちらの発言か分からなくなる
    expect(secretFor(key, resolveIndividual("bob"))).toBe("1号の分");
    expect(secretFor(key, resolveIndividual("walter"))).toBe("2号の分");
  } finally {
    process.env = saved;
  }
});

test("**秘書は会議に入らない**（装備は少ないほど事故が減る, §9.3）", () => {
  const walter = resolveIndividual("walter");

  expect(walter.equipment).not.toContain("meeting");
  // 資料を見て予定を判断できる程度は持たせる
  expect(walter.equipment).toContain("google-drive");
});

test("番頭は、新人より自発的で、口数の枠が広い", () => {
  const walter = resolveIndividual("walter");
  const bob = resolveIndividual("bob");

  // 呼ばれなくても気づいて言うのが役目。ただし枠と静音時間で暴走は抑える（§6）
  expect(walter.temperament.proactivity).toBeGreaterThan(bob.temperament.proactivity);
  expect(walter.temperament.daily_speak_cap).toBeGreaterThan(bob.temperament.daily_speak_cap);
});

/**
 * 止める口は個体ごとに違う。
 *
 * Slack はワークスペース内で**同じコマンド名を2つのアプリに持たせられない**。
 * 揃えてしまうと、後から作った個体は**キルスイッチが効かない**——
 * 止められない個体を動かすことになる。
 */

test("**キルスイッチのコマンド名が、個体ごとに違う**", () => {
  const bob = resolveIndividual("bob");
  const walter = resolveIndividual("walter");

  expect(bob.slashCommand).toBe("/russell");
  expect(walter.slashCommand).toBe("/walter");
  // ここが揃うと、2体目は Slack 側で登録できず、止める手段を失う
  expect(bob.slashCommand).not.toBe(walter.slashCommand);
});

test("すべての個体が、止める口を持っている", () => {
  for (const individual of Object.values(INDIVIDUALS)) {
    expect(individual.slashCommand.startsWith("/")).toBe(true);
  }
  // 名前が重複していないこと（増やしたときに気づけるように）
  const names = Object.values(INDIVIDUALS).map((i) => i.slashCommand);
  expect(new Set(names).size).toBe(names.length);
});
