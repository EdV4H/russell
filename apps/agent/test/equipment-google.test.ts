/**
 * 装備: Google Drive / ドキュメントを読む。env 不要（偽の fetch で通す）。
 *
 * 会議の文字起こしは Google ドキュメントとして Drive に入るので、**共有されていれば読める**。
 * ここで固めたいのは検索の精度より、**見えない・取れないときに嘘をつかない**こと——
 * 認証が切れたのを「0件」と言われると、原因に辿り着けない。
 */

import { createAgent } from "@edv4h/russell-core";
import { createGoogleEquipmentPlugin } from "@edv4h/russell-plugin-equipment-google";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type { RussellPlugin, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/** Google API の代わり。呼ばれた URL を記録し、決めた応答を返す。 */
function fakeGoogle(routes: Record<string, { status?: number; body: unknown; text?: string }>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(url);
    // トークンの発行は常に成功させる（個別に差し替えたいときは routes で上書き）
    if (url.includes("oauth2.googleapis.com/token") && !routes[url]) {
      return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), {
        status: 200,
      });
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : undefined;
    if (!route) return new Response("not found", { status: 404 });
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { calls, fetchImpl: fetchImpl as never };
}

async function withGoogle(
  routes: Record<string, { status?: number; body: unknown; text?: string }>,
  credentials: { clientId?: string; clientSecret?: string; refreshToken?: string } = {
    clientId: "cid",
    clientSecret: "secret",
    refreshToken: "refresh",
  },
) {
  const google = fakeGoogle(routes);
  const plugins: RussellPlugin[] = [
    createInMemoryMemoryPlugin(),
    createGoogleEquipmentPlugin({ ...credentials, fetchImpl: google.fetchImpl }),
  ];
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    plugins,
  );
  return { agent, calls: google.calls };
}

const FILES = {
  body: {
    files: [
      {
        id: "doc-1",
        name: "定例 - 文字起こし",
        modifiedTime: "2026-08-21T02:00:00.000Z",
        webViewLink: "https://docs.google.com/document/d/doc-1",
      },
    ],
  },
};

test("装備として登録され、読む道具だけを持つ", async () => {
  const { agent } = await withGoogle({});

  const eq = agent.ctx.equipment.get("google-drive");
  expect(eq?.tools().map((t) => t.name)).toEqual(["drive.search", "drive.read"]);
  // **書き込みは持たない。** 持てば承認の設計が要る（§9.3 の段階的解放）
  expect(eq?.tools().every((t) => t.effect === "read")).toBe(true);
  expect(eq?.dangerLevel).toBe(0);

  await agent.destroy();
});

test("**認証情報が無ければ装備そのものが存在しない**（未支給, §9.2）", async () => {
  const { agent } = await withGoogle({}, { clientId: "cid" }); // 鍵が揃っていない

  expect(agent.ctx.equipment.get("google-drive")).toBeUndefined();
  expect(agent.ctx.tools.get("drive.search")).toBeUndefined();

  await agent.destroy();
});

test("共有されている文書を探せる", async () => {
  const { agent } = await withGoogle({ "/drive/v3/files?": FILES });

  const result = (await agent.invokeTool("drive.search", { query: "定例" })) as {
    status: string;
    data: { id: string; name: string }[];
    trustLabel: string;
  };

  expect(result.status).toBe("complete");
  expect(result.data[0]?.id).toBe("doc-1");
  // 他者が書いた文書なので untrusted のまま（**来歴を消さない**, §12-3）
  expect(result.trustLabel).toBe("untrusted");

  await agent.destroy();
});

test("探すのは Google ドキュメントだけ、ゴミ箱は除く", async () => {
  const { agent, calls } = await withGoogle({ "/drive/v3/files?": FILES });

  await agent.invokeTool("drive.search", { query: "定例" });

  // URLSearchParams は空白を `+` にする。人が読む形へ戻してから確かめる
  const raw = calls.find((c) => c.includes("/files?")) ?? "";
  const url = decodeURIComponent(raw.replace(/\+/g, " "));
  expect(url).toContain("mimeType = 'application/vnd.google-apps.document'");
  expect(url).toContain("trashed = false");
  // 共有ドライブの文書も対象（チームの置き場はたいていこちら）
  expect(url).toContain("includeItemsFromAllDrives=true");

  await agent.destroy();
});

test("文書を本文つきで読める", async () => {
  const { agent } = await withGoogle({
    "/drive/v3/files/doc-1?": {
      body: { id: "doc-1", name: "定例 - 文字起こし", modifiedTime: "2026-08-21T02:00:00.000Z" },
    },
    "/export?": { text: "丸山: 定例を始めます\nA-san: 配信は来週で" },
  });

  const result = (await agent.invokeTool("drive.read", { fileId: "doc-1" })) as {
    status: string;
    data: { name: string; text: string };
  };

  expect(result.status).toBe("complete");
  expect(result.data.name).toBe("定例 - 文字起こし");
  expect(result.data.text).toContain("丸山: 定例を始めます");

  await agent.destroy();
});

test("**見出しは取れたが本文が読めないときは、完全とは言わない**", async () => {
  const { agent } = await withGoogle({
    "/drive/v3/files/doc-1?": { body: { id: "doc-1", name: "定例 - 文字起こし" } },
    // export は 403（権限が足りない等）
    "/export?": { status: 403, body: {} },
  });

  const result = (await agent.invokeTool("drive.read", { fileId: "doc-1" })) as {
    status: string;
    data: { text: string };
  };

  // 空の本文を complete と言うと、「中身が無い会議」と読める（§6.3）
  expect(result.status).toBe("partial");
  expect(result.data.text).toBe("");

  await agent.destroy();
});

test("**認証できないことを「0件」と言わない**", async () => {
  const { agent } = await withGoogle({
    "oauth2.googleapis.com/token": { status: 400, body: { error: "invalid_grant" } },
  });

  const result = (await agent.invokeTool("drive.search", { query: "定例" })) as {
    status: string;
    data?: unknown[];
  };

  // 「探して0件」と「そもそも探せなかった」は別物
  expect(result.status).toBe("failed");
  expect(result.data).toBeUndefined();

  await agent.destroy();
});

test("空の検索語では API を叩かない", async () => {
  const { agent, calls } = await withGoogle({ "/drive/v3/files?": FILES });

  const result = (await agent.invokeTool("drive.search", { query: "  " })) as {
    status: string;
    data: unknown[];
  };

  expect(result.data).toEqual([]);
  expect(calls.filter((c) => c.includes("/files?"))).toHaveLength(0);

  await agent.destroy();
});
