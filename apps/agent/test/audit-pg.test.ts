/**
 * audit-pg の結合テスト。Postgres が要るので DATABASE_URL がある時だけ実行する。
 * ローカル: `docker compose up -d db` → `DATABASE_URL=postgres://russell:russell@localhost:5432/russell pnpm test`
 *
 * 検証すること:
 * 1. 認知ループの全アクションが event_log に trust_label 付きで残る
 * 2. event_log が **追記専用**（UPDATE/DELETE が DB 側で拒否される）
 */

import { createAgent } from "@edv4h/russell-core";
import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type { InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
import pg from "pg";
import { describe, expect, test } from "vitest";

const DB = process.env.DATABASE_URL;

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

function captureSurface() {
  let sink: ((m: InboundMessage) => void) | undefined;
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake surface",
    setup(ctx) {
      return ctx.surfaces.register({
        id: "fake",
        start(s) {
          sink = s;
        },
        async send() {
          return { status: "succeeded" };
        },
      });
    },
  };
  const push = (text: string) =>
    sink?.({
      surfaceId: "fake",
      contextId: "t1",
      author: "u-slack-123",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, push };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe.skipIf(!DB)("audit-pg（DATABASE_URL 必須）", () => {
  test("認知ループのアクションが event_log に trust_label 付きで残る", async () => {
    const agentId = `test-${Date.now()}`; // 実行ごとに一意にして分離
    const s = captureSurface();
    const agent = await createAgent(
      { agentId, configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
      [
        createPgAuditPlugin({ autoMigrate: true }),
        createInMemoryMemoryPlugin(),
        createEchoModelPlugin(),
        s.plugin,
      ],
    );

    s.push("金曜の定例、覚えておいて");
    await drain();
    await agent.destroy();

    const pool = new pg.Pool({ connectionString: DB });
    try {
      const res = await pool.query<{ action: string; trust_label: string; actor: string }>(
        "SELECT action, trust_label, actor FROM event_log WHERE agent_id = $1 ORDER BY id",
        [agentId],
      );
      const actions = res.rows.map((r) => r.action);
      expect(actions).toContain("agent.started");
      expect(actions).toContain("turn.received");
      expect(actions).toContain("tool.invoked");
      expect(actions).toContain("surface.send");
      expect(actions).toContain("agent.stopped");

      // 来歴が残る（§12-3）
      const received = res.rows.find((r) => r.action === "turn.received");
      expect(received?.trust_label).toBe("untrusted");
      expect(received?.actor).toBe("u-slack-123");
    } finally {
      await pool.end();
    }
  });

  test("event_log は追記専用（UPDATE/DELETE/TRUNCATE が DB 側で拒否される）", async () => {
    const pool = new pg.Pool({ connectionString: DB });
    try {
      const { AUDIT_SCHEMA_SQL } = await import("@edv4h/russell-plugin-audit-pg");
      await pool.query(AUDIT_SCHEMA_SQL);
      await pool.query(
        `INSERT INTO event_log (agent_id, config_version, actor, action, payload, trust_label)
         VALUES ('append-only-test', 'v0', 'tester', 'test.event', '{}'::jsonb, 'trusted')`,
      );

      await expect(
        pool.query("UPDATE event_log SET action = 'tampered' WHERE agent_id = 'append-only-test'"),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM event_log WHERE agent_id = 'append-only-test'"),
      ).rejects.toThrow(/append-only/);
      // TRUNCATE は行トリガを迂回するので、文トリガで塞げているかを別途確かめる
      await expect(pool.query("TRUNCATE event_log")).rejects.toThrow(/append-only/);

      const res = await pool.query(
        "SELECT action FROM event_log WHERE agent_id = 'append-only-test'",
      );
      expect(res.rows.length).toBeGreaterThan(0);
      expect(res.rows[0]?.action).toBe("test.event");
    } finally {
      await pool.end();
    }
  });
});
