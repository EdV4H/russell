/**
 * memory-pg の結合テスト。Postgres(pgvector) が要るので DATABASE_URL がある時だけ実行する。
 * ローカル: `docker compose up -d db` → `DATABASE_URL=postgres://russell:russell@localhost:5432/russell pnpm test`
 * CI: postgres サービス（pgvector）を立てて DATABASE_URL を渡す。
 */

import { createPgMemoryPlugin } from "@edv4h/russell-plugin-memory-pg";
import type { MemoryCapability, ToolSpec } from "@edv4h/russell-shared";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("memory-pg（DATABASE_URL 必須）", () => {
  test("note.write / shelf.add / recall / deep_recall が Postgres で動く", async () => {
    const tools = new Map<string, ToolSpec>();
    let capability: MemoryCapability | undefined;
    const ctx = {
      runtime: { agentId: `test-${Date.now()}` }, // 実行ごとに一意にして分離
      services: {
        provide(key: string, value: unknown) {
          if (key === "memory") capability = value as MemoryCapability;
        },
      },
      policy: { declareEffect() {} },
      tools: {
        register(name: string, tool: ToolSpec) {
          tools.set(name, tool);
          return () => tools.delete(name);
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: memory-pg が触る部分だけのテスト用スタブ。
    } as any;

    const teardown = await createPgMemoryPlugin({ autoMigrate: true }).setup(ctx);
    try {
      await tools.get("note.write")?.run({ contextId: "c1", content: "テストメモ1" });
      await tools.get("shelf.add")?.run({ source: "c1", card: "金曜の定例" });

      const recalled = await capability?.recall("c1");
      expect(recalled?.notes).toContain("テストメモ1");
      expect(recalled?.books.some((b) => b.card === "金曜の定例")).toBe(true);

      const hits = (await tools.get("deep_recall")?.run({ query: "定例" })) as unknown[];
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      if (typeof teardown === "function") await teardown();
    }
  });
});
