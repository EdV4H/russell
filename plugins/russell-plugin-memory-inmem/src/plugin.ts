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
      const books: (RecalledBook & { archived?: boolean })[] = [];
      const termBook = new Map<string, { name: string; definition: string; aliases: string[] }>();
      const personBook = new Map<string, { name: string; definition: string; aliases: string[] }>();

      const capability: MemoryCapability = {
        people(text: string) {
          return [...personBook.values()]
            .filter((p) =>
              [p.name, ...p.aliases].some(
                (a) => a.length >= 2 && text.toLowerCase().includes(a.toLowerCase()),
              ),
            )
            .map((p) => ({ name: p.name, note: p.definition }));
        },
        glossary() {
          return [...termBook.values()].map((t) => ({ name: t.name, aliases: t.aliases }));
        },
        terms(text: string) {
          const hits = [...termBook.values()].filter((t) =>
            [t.name, ...t.aliases].some(
              (a) => a.length >= 2 && text.toLowerCase().includes(a.toLowerCase()),
            ),
          );
          return hits.map((t) => ({ name: t.name, definition: t.definition }));
        },
        recall(contextId: string): RecalledContext {
          return {
            notes: notesByContext.get(contextId) ?? [],
            // 書庫に落ちた本は想起に出さない（L1 の効果）
            books: books.filter((b) => !b.archived).slice(-5),
          };
        },
      };
      ctx.services.provide<MemoryCapability>(MEMORY_SERVICE, capability);

      // 効果分類を Policy Gate へ申告（§9.2）。記憶書き込みは internal_write。
      ctx.policy.declareEffect("note.write", "internal_write");
      ctx.policy.declareEffect("shelf.add", "internal_write");
      ctx.policy.declareEffect("shelf.forget", "internal_write");
      ctx.policy.declareEffect("deep_recall", "read");
      ctx.policy.declareEffect("term.define", "internal_write");
      ctx.policy.declareEffect("person.remember", "internal_write");

      const offNote = ctx.tools.register("note.write", {
        name: "note.write",
        effect: "internal_write",
        async run(input: { contextId: string; content: string; sensitive?: string[] }) {
          const list = notesByContext.get(input.contextId) ?? [];
          list.push(input.content);
          notesByContext.set(input.contextId, list);
          return { status: "succeeded" as const };
        },
      });

      // 単語帳（索引カード）。同じ語は1件で更新する。
      const offTerm = ctx.tools.register("term.define", {
        name: "term.define",
        effect: "internal_write",
        async run(input: { name: string; definition: string; aliases?: string[] }) {
          const name = (input.name ?? "").trim();
          if (name === "" || (input.definition ?? "").trim() === "") {
            return { status: "succeeded" as const, saved: false };
          }
          const prev = termBook.get(name.toLowerCase());
          termBook.set(name.toLowerCase(), {
            name,
            definition: input.definition,
            // 別名は和集合。勝手に呼び名を忘れない
            aliases: [...new Set([...(prev?.aliases ?? []), ...(input.aliases ?? [])])],
          });
          return { status: "succeeded" as const, saved: true };
        },
      });

      const offPerson = ctx.tools.register("person.remember", {
        name: "person.remember",
        effect: "internal_write",
        async run(input: { name: string; note: string; aliases?: string[] }) {
          const name = (input.name ?? "").trim();
          if (name === "" || (input.note ?? "").trim() === "") {
            return { status: "succeeded" as const, saved: false };
          }
          const prev = personBook.get(name.toLowerCase());
          personBook.set(name.toLowerCase(), {
            name,
            definition: input.note,
            aliases: [...new Set([...(prev?.aliases ?? []), ...(input.aliases ?? [])])],
          });
          return { status: "succeeded" as const, saved: true };
        },
      });

      const offShelf = ctx.tools.register("shelf.add", {
        name: "shelf.add",
        effect: "internal_write",
        async run(input: { source: string; card: string; title?: string; sensitive?: string[] }) {
          // 見出しはモデルが書く。無ければ本文の頭を切る——索引としては読めないが、
          // 本が載らないよりはよい（判定が壊れても記憶は残す, ADR 0003）。
          const title = input.title?.trim() || input.card.slice(0, 24);
          books.push({ title, card: input.card });
          return { status: "succeeded" as const, title };
        },
      });

      // 「忘れて」= L1（弱める）。書庫へ落とすだけで、データは残る（可逆）。
      const offForget = ctx.tools.register("shelf.forget", {
        name: "shelf.forget",
        effect: "internal_write",
        async run(input: { query: string }) {
          const q = input.query ?? "";
          const hit = q.trim() === "" ? [] : books.filter((b) => !b.archived && b.card.includes(q));
          for (const b of hit) b.archived = true;
          return {
            status: "succeeded" as const,
            archived: hit.length,
            titles: hit.map((b) => b.title),
          };
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
        offTerm();
        offPerson();
        offNote();
        offShelf();
        offForget();
        offRecall();
        notesByContext.clear();
        books.length = 0;
      };
    },
  };
}
