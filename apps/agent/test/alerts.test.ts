/**
 * 安全側に倒れたことを運用者へ届ける（#25）。env 不要。
 *
 * 外から見ると、**正常に静か / 監査が壊れて全停止 / 凍結状態が読めず沈黙 / プロセスが落ちた**
 * が全部同じ姿になる。黙ること自体は設計どおりで、**問題は黙ったことが誰にも届かないこと**。
 *
 * ここで固めたいのは、**壊れているときに届く**ことと、**同じ知らせで埋めない**こと。
 */

import { createAgent } from "@edv4h/russell-core";
import {
  ALERT_EVENTS,
  createAlertThrottle,
  createAlertsPlugin,
} from "@edv4h/russell-plugin-alerts";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import {
  ALERT_SERVICE,
  type AlertSink,
  type RussellPlugin,
  type Temperament,
} from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/** 受け取り口。通信面の代わり。 */
function sinkPlugin() {
  const sent: string[] = [];
  const plugin: RussellPlugin = {
    id: "sink",
    name: "sink",
    setup(ctx) {
      ctx.services.provide<AlertSink>(ALERT_SERVICE, {
        async send(text) {
          sent.push(text);
        },
      });
    },
  };
  return { plugin, sent };
}

async function withAlerts(windowMs = 60_000) {
  const s = sinkPlugin();
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), s.plugin, createAlertsPlugin({ windowMs })],
  );
  return { agent, sent: s.sent };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test("監査が書けなくなったことが運用者に届く", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit("audit:degraded", {});
  await settle();

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("監査が書けなくなりました");
  // 何が止まるかまで書く（受け取った人が次に何をすべきか分かるように）
  expect(sent[0]).toContain("以降のターンは止まります");
  // どの個体の話かが分かる
  expect(sent[0]).toContain("bob");

  await agent.destroy();
});

test("復帰も届く（「まだ壊れている」と思わせない）", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit("audit:recovered", {});
  await settle();

  expect(sent[0]).toContain("応答を再開します");

  await agent.destroy();
});

test("凍結状態が読めないことも届く（これが黙る原因の筆頭）", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit("killswitch:unreadable", { error: "DB 障害" });
  await settle();

  expect(sent[0]).toContain("完全沈黙");

  await agent.destroy();
});

test("**本文は入れない**（拒否された道具の名前までにとどめる, A1-5）", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit("policy:blocked", { tool: "notion.search", reason: "未申告" });
  await settle();

  expect(sent[0]).toContain("notion.search");
  expect(sent[0]).not.toContain("未申告"); // reason は載せない（何が入るか分からない）

  await agent.destroy();
});

test("同じ知らせで埋めない（1件目はすぐ、以降はまとめて）", async () => {
  const { agent, sent } = await withAlerts(60_000);

  for (let i = 0; i < 5; i++) agent.ctx.events.emit("turn:error", new Error("失敗"));
  await settle();

  // 1件目だけが出る。残りは窓が明けるまで溜まる
  expect(sent).toHaveLength(1);

  await agent.destroy();
});

test("溜めた件数は捨てない（10分で1件と400件は別の話）", () => {
  let now = 0;
  const throttle = createAlertThrottle(1000, () => now);

  expect(throttle.admit("turn:error")).toBe(1); // 初回はすぐ
  expect(throttle.admit("turn:error")).toBe(0); // 窓の中は黙る
  expect(throttle.admit("turn:error")).toBe(0);

  now = 1000; // 窓が明ける
  expect(throttle.admit("turn:error")).toBe(3); // 溜めた2件 + 今回
});

test("種類が違えば別々に数える（片方が溢れても、もう片方が隠れない）", () => {
  const throttle = createAlertThrottle(1000, () => 0);

  expect(throttle.admit("audit:degraded")).toBe(1);
  expect(throttle.admit("killswitch:unreadable")).toBe(1);
  expect(throttle.admit("audit:degraded")).toBe(0);
});

test("宛先が無い構成でも落ちない（ログには出す）", async () => {
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, model: "echo", mode: "live" },
    [createInMemoryMemoryPlugin(), createAlertsPlugin()],
  );

  expect(() => agent.ctx.events.emit("audit:degraded", {})).not.toThrow();

  await agent.destroy();
});

test("拾う対象に、黙る原因が全部入っている", () => {
  // 外から見て「Bob が黙っている」に見える経路は、必ずどれかで知らせる
  expect(Object.keys(ALERT_EVENTS)).toEqual(
    expect.arrayContaining([
      "audit:degraded",
      "killswitch:unreadable",
      "turn:error",
      "policy:blocked",
    ]),
  );
});

/**
 * ターンの失敗は、理由まで出す。
 *
 * 出していなかったので `⚠️ ターンが失敗しました` だけが毎回流れ、**何が起きているのか
 * 誰にも分からなかった**。知らせるだけで理由を落とすなら、知らせていないのと大差ない。
 */

test("**ターンが失敗した理由を載せる**", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit(
    "turn:error",
    new Error("model-claude-code: 120000ms で応答がありませんでした"),
  );
  await settle();

  expect(sent[0]).toContain("ターンが失敗");
  expect(sent[0]).toContain("120000ms");

  await agent.destroy();
});

test("長い理由は切り詰める（stderr をそのまま流さない）", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit("turn:error", new Error(`頭: ${"あ".repeat(500)}`));
  await settle();

  expect(sent[0]).toContain("頭:");
  // 1行目だけ・上限つき。長さで頭を打つ（A1-5 の観点でも）
  expect((sent[0] ?? "").length).toBeLessThan(300);

  await agent.destroy();
});

test("複数行のエラーは1行目だけ（後続に何が入るか分からない）", async () => {
  const { agent, sent } = await withAlerts();

  agent.ctx.events.emit("turn:error", new Error("1行目です\n2行目は載せない"));
  await settle();

  expect(sent[0]).toContain("1行目です");
  expect(sent[0]).not.toContain("2行目");

  await agent.destroy();
});
