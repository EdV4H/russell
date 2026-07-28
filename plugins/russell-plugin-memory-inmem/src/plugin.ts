/**
 * 記憶プラグイン（dev スタブ・インメモリ）。
 * - services に MEMORY_SERVICE capability（recall）を提供
 * - tools に note.write / shelf.add / deep_recall を登録し、効果分類を policy へ申告
 *
 * 本番は @edv4h/russell-plugin-memory-pg（pgvector）に差し替える。契約は同じ。
 */

import {
  type AgentContext,
  MEMORY_SERVICE,
  type MemoryCapability,
  type RecalledBook,
  type RecalledContext,
  type RussellPlugin,
} from "@edv4h/russell-shared";

export function createInMemoryMemoryPlugin(): RussellPlugin {
  return {
    id: "russell-plugin-memory-inmem",
    name: "In-Memory Memory (dev stub)",
    setup(ctx: AgentContext) {
      // スレッド単位のメモ帳と、個体全体の本棚（インメモリ）
      const notesByContext = new Map<string, string[]>();
      const books: RecalledBook[] = [];

      const capability: MemoryCapability = {
        recall(contextId: string): RecalledContext {
          return {
            notes: notesByContext.get(contextId) ?? [],
            books: books.slice(-5), // 直近の本を少しだけ注入（§3.2 の簡易版）
          };
        },
      };
      ctx.services.provide<MemoryCapability>(MEMORY_SERVICE, capability);

      // 効果分類を Policy Gate へ申告（§9.2）。記憶書き込みは internal_write。
      ctx.policy.declareEffect("note.write", "internal_write");
      ctx.policy.declareEffect("shelf.add", "internal_write");
      ctx.policy.declareEffect("deep_recall", "read");

      const offNote = ctx.tools.register("note.write", {
        name: "note.write",
        effect: "internal_write",
        async run(input: { contextId: string; content: string }) {
          const list = notesByContext.get(input.contextId) ?? [];
          list.push(input.content);
          notesByContext.set(input.contextId, list);
          return { status: "succeeded" as const };
        },
      });

      const offShelf = ctx.tools.register("shelf.add", {
        name: "shelf.add",
        effect: "internal_write",
        async run(input: { source: string; card: string }) {
          const title = input.card.slice(0, 24);
          books.push({ title, card: input.card });
          return { status: "succeeded" as const, title };
        },
      });

      const offRecall = ctx.tools.register("deep_recall", {
        name: "deep_recall",
        effect: "read",
        async run(input: { query: string }) {
          const q = input.query ?? "";
          return books.filter((b) => b.card.includes(q));
        },
      });

      return () => {
        offNote();
        offShelf();
        offRecall();
        notesByContext.clear();
        books.length = 0;
      };
    },
  };
}
