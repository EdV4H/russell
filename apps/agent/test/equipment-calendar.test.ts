/**
 * 装備: Google カレンダーを読む（秘書役 Walter の最初の装備）。env 不要（偽の fetch で通す）。
 *
 * 秘書の仕事は「予定と約束を落とさない」ことなので、まず**見えること**から始める。
 * ここで固めたいのは、**見えないときに嘘をつかない**こと——共有されていないのを
 * 「予定なし」と言われると、その日は空いていることになってしまう。
 */

import { createAgent } from "@edv4h/russell-core";
import {
  attendeeNames,
  createCalendarEquipmentPlugin,
  rangeOf,
} from "@edv4h/russell-plugin-equipment-google";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type { RussellPlugin, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const WALTER: Temperament = {
  name: "Walter",
  tone: "落ち着いている",
  proactivity: 0.7,
  daily_speak_cap: 5,
  curiosity: 0.6,
  reaction_rate: 0.5,
};

/** Google API の代わり。呼ばれた URL を記録し、決めた応答を返す。 */
function fakeGoogle(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.includes("oauth2.googleapis.com/token") && !routes[url]) {
      return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), {
        status: 200,
      });
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : undefined;
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { calls, fetchImpl: fetchImpl as never };
}

async function withCalendar(
  routes: Record<string, { status?: number; body: unknown }>,
  credentials: { clientId?: string; clientSecret?: string; refreshToken?: string } = {
    clientId: "cid",
    clientSecret: "secret",
    refreshToken: "refresh",
  },
) {
  const google = fakeGoogle(routes);
  const plugins: RussellPlugin[] = [
    createInMemoryMemoryPlugin(),
    createCalendarEquipmentPlugin({ ...credentials, fetchImpl: google.fetchImpl }),
  ];
  const agent = await createAgent(
    { agentId: "walter", configVersion: "v0", temperament: WALTER, mode: "live", model: "echo" },
    plugins,
  );
  return { agent, calls: google.calls };
}

const EVENTS = {
  body: {
    items: [
      {
        id: "ev-1",
        summary: "週次定例",
        htmlLink: "https://calendar.google.com/event?eid=ev-1",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        start: { dateTime: "2026-09-01T02:00:00.000Z" },
        end: { dateTime: "2026-09-01T03:00:00.000Z" },
        attendees: [{ displayName: "本人", self: true }, { displayName: "同僚A" }],
      },
    ],
  },
};

test("装備として登録され、読む道具だけを持つ", async () => {
  const { agent } = await withCalendar({});

  const eq = agent.ctx.equipment.get("google-calendar");
  expect(eq?.tools().map((t) => t.name)).toEqual(["calendar.upcoming"]);
  // **予定を作る・動かすは持たない。** 他人の時間に触るので、承認の設計と一緒に足す
  expect(eq?.tools().every((t) => t.effect === "read")).toBe(true);
  expect(eq?.dangerLevel).toBe(0);

  await agent.destroy();
});

test("**認証情報が無ければ装備そのものが存在しない**（未支給, §9.2）", async () => {
  const { agent } = await withCalendar({}, { clientId: "cid" });

  expect(agent.ctx.equipment.get("google-calendar")).toBeUndefined();
  expect(agent.ctx.tools.get("calendar.upcoming")).toBeUndefined();

  await agent.destroy();
});

test("これからの予定を、誰と・いつ・どこで まで読める", async () => {
  const { agent } = await withCalendar({ "/calendars/primary/events?": EVENTS });

  const result = (await agent.invokeTool("calendar.upcoming", { days: 7 })) as {
    status: string;
    data: { title: string; attendees: string[]; conference?: string }[];
    trustLabel: string;
  };

  expect(result.status).toBe("complete");
  expect(result.data[0]?.title).toBe("週次定例");
  expect(result.data[0]?.conference).toContain("meet.google.com");
  // 他者が書いた予定なので untrusted のまま（**来歴を消さない**, §12-3）
  expect(result.trustLabel).toBe("untrusted");

  await agent.destroy();
});

test("**自分は参加者に数えない**（知りたいのは「誰と会うか」）", () => {
  expect(attendeeNames([{ displayName: "本人", self: true }, { displayName: "同僚A" }])).toEqual([
    "同僚A",
  ]);
  // 表示名が無ければメール。**当てにいかない**
  expect(attendeeNames([{ email: "a@example.com" }])).toEqual(["a@example.com"]);
  expect(attendeeNames(undefined)).toEqual([]);
});

test("**件名の無い予定を、一覧から消さない**", async () => {
  const { agent } = await withCalendar({
    "/calendars/primary/events?": { body: { items: [{ id: "ev-2", start: {} }] } },
  });

  const result = (await agent.invokeTool("calendar.upcoming", {})) as {
    data: { title: string }[];
  };

  // 空にすると一覧から消えて、**予定が無い日に見える**
  expect(result.data[0]?.title).toBe("（件名なし）");

  await agent.destroy();
});

test("**繰り返しの予定は展開する**（次がいつか分からないと使えない）", async () => {
  const { agent, calls } = await withCalendar({ "/calendars/primary/events?": EVENTS });

  await agent.invokeTool("calendar.upcoming", {});

  const url = calls.find((c) => c.includes("/events?")) ?? "";
  expect(url).toContain("singleEvents=true");
  expect(url).toContain("orderBy=startTime");

  await agent.destroy();
});

test("**過去は既定で見ない**（終わった予定を持ち出しても役に立たない）", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const range = rangeOf({}, now);

  expect(range.min).toBe(now.toISOString());
  expect(new Date(range.max).getTime() - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
});

test("期間は上限で頭を打つ（際限なく先まで見ない）", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const days = (r: { min: string; max: string }) =>
    (new Date(r.max).getTime() - new Date(r.min).getTime()) / (24 * 60 * 60 * 1000);

  expect(days(rangeOf({ days: 365 }, now))).toBe(60);
  expect(days(rangeOf({ days: 0 }, now))).toBe(1);
  // 壊れた日付は「いま」に倒す
  expect(rangeOf({ from: "なにか" }, now).min).toBe(now.toISOString());
});

test("**共有されていないことを「予定なし」と言わない**", async () => {
  const { agent } = await withCalendar({
    "/calendars/primary/events?": { status: 403, body: {} },
  });

  const result = (await agent.invokeTool("calendar.upcoming", {})) as {
    status: string;
    data?: unknown[];
    detail?: string;
  };

  // 「見られなかった」を「その日は空いている」に潰さない
  expect(result.status).toBe("unauthorized");
  expect(result.data).toBeUndefined();
  expect(result.detail).toContain("403");

  await agent.destroy();
});

test("**認証できないことを「予定なし」と言わない**", async () => {
  const { agent } = await withCalendar({
    "oauth2.googleapis.com/token": { status: 400, body: { error: "invalid_grant" } },
  });

  const result = (await agent.invokeTool("calendar.upcoming", {})) as {
    status: string;
    data?: unknown[];
  };

  expect(result.status).toBe("failed");
  expect(result.data).toBeUndefined();

  await agent.destroy();
});
