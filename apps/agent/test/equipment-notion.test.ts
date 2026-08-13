/**
 * 装備（§9）: Notion の読み取り。env 不要（`fetch` を差し替えて実ネットワークを使わない）。
 *
 * 装備で守りたいのは3つ:
 * - **未支給なら存在しない** — トークンが無ければツール定義自体が生えない（§9.2）
 * - **Policy Gate を通る** — 効果分類を申告し、未申告なら deny されること
 * - **「取れなかった」を「無かった」にしない** — SourceResult の status（§6.3）
 */

import { createAgent } from "@edv4h/russell-core";
import { createNotionEquipmentPlugin } from "@edv4h/russell-plugin-equipment-notion";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type { RussellPlugin, SourceResult, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/** Notion API の代わり。呼ばれた URL を記録し、決めたレスポンスを返す。 */
function fakeNotion(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; auth?: string; body?: string }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : undefined;
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { calls, fetchImpl };
}

const SEARCH_HIT = {
  results: [
    {
      id: "page-1",
      url: "https://notion.so/page-1",
      last_edited_time: "2026-08-10T00:00:00.000Z",
      properties: { 名前: { type: "title", title: [{ plain_text: "定例メモ" }] } },
    },
  ],
  has_more: false,
};

const PAGE = {
  id: "page-1",
  url: "https://notion.so/page-1",
  last_edited_time: "2026-08-10T00:00:00.000Z",
  properties: { 名前: { type: "title", title: [{ plain_text: "定例メモ" }] } },
};

const BLOCKS = {
  results: [
    { type: "heading_1", heading_1: { rich_text: [{ plain_text: "議事録" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "定例は金曜15時に変更" }] } },
    { type: "to_do", to_do: { rich_text: [{ plain_text: "資料を作る" }], checked: false } },
    { type: "image", image: { file: { url: "https://example.com/x.png" } } },
  ],
  has_more: false,
};

async function withNotion(
  routes: Record<string, { status?: number; body: unknown }>,
  // null = 支給されていない。`undefined` だとデフォルト引数が効いてトークン有りになる
  token: string | null = "secret-token",
) {
  const notion = fakeNotion(routes);
  const plugins: RussellPlugin[] = [
    createInMemoryMemoryPlugin(),
    createNotionEquipmentPlugin({ token: token ?? undefined, fetchImpl: notion.fetchImpl }),
    createEchoModelPlugin(),
  ];
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    plugins,
  );
  return { agent, calls: notion.calls };
}

test("装備として登録され、読む道具と書く道具を持つ", async () => {
  const { agent } = await withNotion({});

  const notion = agent.ctx.equipment.get("notion");
  expect(notion?.scopes).toEqual(["notion:read", "notion:write"]);
  // 効果分類から導出。**書けるようになった以上 0 ではない**（2以上は毎回 HITL, guides/22）
  expect(notion?.dangerLevel).toBe(2);
  expect(notion?.tools().map((t) => t.name)).toEqual([
    "notion.search",
    "notion.read_page",
    "notion.create_page",
    "notion.append",
    "notion.edit",
  ]);
  // 書く道具は external_write。**内部の書き込みとして紛れ込ませない**
  const writes = notion?.tools().filter((t) => t.effect !== "read") ?? [];
  expect(writes.map((t) => t.effect)).toEqual([
    "external_write",
    "external_write",
    "external_write",
  ]);

  await agent.destroy();
});

test("トークンが無ければ装備そのものが存在しない（未支給, §9.2）", async () => {
  const { agent } = await withNotion({}, null);

  expect(agent.ctx.equipment.get("notion")).toBeUndefined();
  // ツール定義も生えない＝モデルは持っていない能力の存在すら知らない
  await expect(agent.invokeTool("notion.search", { query: "x" }, "untrusted")).rejects.toThrow();

  await agent.destroy();
});

test("検索は Policy Gate を通り、結果を返す", async () => {
  const { agent, calls } = await withNotion({ "/search": { body: SEARCH_HIT } });

  const result = (await agent.invokeTool(
    "notion.search",
    { query: "定例" },
    "untrusted",
  )) as SourceResult<{ title: string; url: string }[]> & { trustLabel: string };

  expect(result.status).toBe("complete");
  expect(result.data?.[0]).toMatchObject({ title: "定例メモ", url: "https://notion.so/page-1" });
  // 外部から持ち込んだテキストは untrusted のまま（§12-3）
  expect(result.trustLabel).toBe("untrusted");
  // 監査には呼んだ事実だけが残る。検索語（＝会話由来のテキスト）は残さない（A1-5）
  const invoked = agent.ctx.audit.recent().find((e) => e.action === "tool.invoked");
  expect(invoked?.payload).toEqual({ tool: "notion.search", effect: "read" });
  expect(JSON.stringify(invoked?.payload)).not.toContain("定例");
  expect(calls[0]?.auth).toBe("Bearer secret-token");

  await agent.destroy();
});

test("ページを読むと本文がテキストになる（画像などは落とす）", async () => {
  const { agent } = await withNotion({
    "/pages/": { body: PAGE },
    "/blocks/": { body: BLOCKS },
  });

  const result = (await agent.invokeTool(
    "notion.read_page",
    { pageId: "page-1" },
    "untrusted",
  )) as SourceResult<{ title: string; text: string }>;

  expect(result.status).toBe("complete");
  expect(result.data?.title).toBe("定例メモ");
  expect(result.data?.text).toBe("# 議事録\n定例は金曜15時に変更\n- [ ] 資料を作る");

  await agent.destroy();
});

test("権限が無いときは unauthorized。空の結果にしない（§6.3）", async () => {
  const { agent } = await withNotion({ "/search": { status: 401, body: {} } });

  const result = (await agent.invokeTool(
    "notion.search",
    { query: "定例" },
    "untrusted",
  )) as SourceResult<unknown[]>;

  // 「見つからなかった」と「取りに行けなかった」を混同すると、個体が
  // 「Notion には何もありませんでした」と嘘をつくことになる
  expect(result.status).toBe("unauthorized");
  expect(result.data).toBeUndefined();

  await agent.destroy();
});

test("続きがあるときは complete と名乗らない（完全性契約）", async () => {
  const { agent } = await withNotion({
    "/search": { body: { ...SEARCH_HIT, has_more: true } },
  });

  const result = (await agent.invokeTool(
    "notion.search",
    { query: "定例" },
    "untrusted",
  )) as SourceResult<unknown[]>;

  expect(result.status).toBe("partial");

  await agent.destroy();
});

test("ページは読めたが本文が読めなければ partial", async () => {
  const { agent } = await withNotion({
    "/pages/": { body: PAGE },
    "/blocks/": { status: 500, body: {} },
  });

  const result = (await agent.invokeTool(
    "notion.read_page",
    { pageId: "page-1" },
    "untrusted",
  )) as SourceResult<{ title: string; text: string }>;

  expect(result.status).toBe("partial");
  expect(result.data?.title).toBe("定例メモ"); // 取れた分は返す
  expect(result.data?.text).toBe("");

  await agent.destroy();
});

test("ネットワークが落ちても例外にせず failed で返す", async () => {
  const notion = {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  const agent = await createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "live", model: "echo" },
    [
      createInMemoryMemoryPlugin(),
      createNotionEquipmentPlugin({ token: "t", fetchImpl: notion.fetchImpl }),
      createEchoModelPlugin(),
    ],
  );

  const result = (await agent.invokeTool(
    "notion.search",
    { query: "定例" },
    "untrusted",
  )) as SourceResult<unknown[]>;
  expect(result.status).toBe("failed");

  await agent.destroy();
});

test("空の検索語では外部を叩かない", async () => {
  const { agent, calls } = await withNotion({ "/search": { body: SEARCH_HIT } });

  const result = (await agent.invokeTool(
    "notion.search",
    { query: "   " },
    "untrusted",
  )) as SourceResult<unknown[]>;

  expect(result.status).toBe("complete");
  expect(result.data).toEqual([]);
  expect(calls).toHaveLength(0);

  await agent.destroy();
});

test("**どこへ書くかを、承認画面に名前で出す**（id では判断できない）", async () => {
  const { agent } = await withNotion({
    // 親ページの見出しを引く経路（GET /pages/:id）に答える
    "/pages/parent-1": {
      body: { properties: { title: { type: "title", title: [{ plain_text: "設計メモ" }] } } },
    },
  });

  const tool = agent.ctx.tools.get("notion.create_page");
  const described = await tool?.describe?.({
    title: "議事録",
    body: "決まったこと",
    parentPageId: "parent-1",
  });

  expect(described?.summary).toContain("設計メモ"); // どこへ
  expect(described?.summary).toContain("議事録"); // 何を
  expect(described?.preview).toBe("決まったこと"); // 中身はそのまま

  await agent.destroy();
});

test("見出しが引けなければ id をそのまま見せる（当てない）", async () => {
  const { agent } = await withNotion({}); // /pages/... は 404 になる

  const described = await agent.ctx.tools
    .get("notion.append")
    ?.describe?.({ pageId: "page-xyz", body: "追記" });

  expect(described?.summary).toContain("page-xyz");

  await agent.destroy();
});

test("場所が分からなければ書かない（承認を通っても）", async () => {
  const { agent } = await withNotion({});

  const result = (await agent.ctx.tools
    .get("notion.create_page")
    ?.run({ title: "議事録", body: "本文" })) as { status: string };

  // 既定の作成先も指定も無い。**どこへ書くか分からないまま書きにいかない**
  expect(result.status).toBe("failed");

  await agent.destroy();
});

test("**編集の承認画面には、消える文と入る文を並べて出す**", async () => {
  const { agent } = await withNotion({
    "/pages/page-1": { body: PAGE },
    "/blocks/page-1/children": {
      body: {
        results: [
          {
            id: "b1",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "定例は金曜15時から" }] },
          },
        ],
      },
    },
  });

  const described = await agent.ctx.tools.get("notion.edit")?.describe?.({
    pageId: "page-1",
    find: "定例は金曜15時から",
    replace: "定例は木曜14時から",
  });

  // 入る文だけでは、押す人は何が失われるか分からない
  expect(described?.preview).toContain("− 定例は金曜15時から");
  expect(described?.preview).toContain("＋ 定例は木曜14時から");
  expect(described?.summary).toContain("定例メモ"); // どのページか

  await agent.destroy();
});

test("直す場所が決まらないことも、押す前に見せる", async () => {
  const { agent } = await withNotion({
    "/pages/page-1": { body: PAGE },
    "/blocks/page-1/children": { body: { results: [] } },
  });

  const described = await agent.ctx.tools
    .get("notion.edit")
    ?.describe?.({ pageId: "page-1", find: "無い文", replace: "新しい文" });

  expect(described?.summary).toContain("見つかりません");

  await agent.destroy();
});

test("**まとめて直すときは、入れてから消す**（途中で失敗しても消失しない）", async () => {
  const { agent, calls } = await withNotion({
    "/blocks/page-1/children": {
      body: {
        results: [
          { id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "古い1行目" }] } },
          { id: "b2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "古い2行目" }] } },
        ],
      },
    },
    "/blocks/b1": { body: {} },
    "/blocks/b2": { body: {} },
  });

  const result = (await agent.ctx.tools.get("notion.edit")?.run({
    pageId: "page-1",
    find: "古い1行目\n古い2行目",
    replace: "## 新しい見出し\n新しい本文",
  })) as { status: string };

  expect(result.status).toBe("complete");
  // 差し込みが先。**消してから入れると、途中で失敗したときに消えたままになる**
  const order = calls.map((c) => c.url);
  const insertAt = order.findIndex((u) => u.includes("/children"), 1);
  const deleteAt = order.findIndex((u) => u.endsWith("/blocks/b1"));
  expect(insertAt).toBeLessThan(deleteAt);
  // 古い行は2つとも消える
  expect(order.filter((u) => u.endsWith("/blocks/b1") || u.endsWith("/blocks/b2"))).toHaveLength(2);

  await agent.destroy();
});

test("消し残しがあれば、完全とは言わない", async () => {
  const { agent } = await withNotion({
    "/blocks/page-1/children": {
      body: {
        results: [
          { id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "古い行" }] } },
        ],
      },
    },
    // /blocks/b1 への DELETE は 404（消せない）
  });

  const result = (await agent.ctx.tools
    .get("notion.edit")
    ?.run({ pageId: "page-1", find: "古い行", replace: "新しい行" })) as { status: string };

  // 古い行が残っているので complete ではない
  expect(result.status).toBe("partial");

  await agent.destroy();
});

test("承認の後にもう一度探し、変わっていたら書き換えない", async () => {
  const { agent } = await withNotion({
    "/blocks/page-1/children": { body: { results: [] } }, // 承認の間に消えた/直された
  });

  const result = (await agent.ctx.tools
    .get("notion.edit")
    ?.run({ pageId: "page-1", find: "承認したときの文", replace: "新しい文" })) as {
    status: string;
  };

  // 承認したときと違うものを上書きしない
  expect(result.status).toBe("failed");

  await agent.destroy();
});
