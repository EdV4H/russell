/**
 * killswitch-pg の結合テスト。Postgres が要るので DATABASE_URL がある時だけ実行する。
 * ローカル: `docker compose up -d db` → `DATABASE_URL=postgres://russell:russell@localhost:5432/russell pnpm test`
 *
 * 検証すること:
 * 1. `/russell stop` が**プロセスを跨いで**効く（凍結は DB にある）
 * 2. `--all` は他の個体にも効く
 * 3. 解除で戻る／発動・解除が event_log に残る（理由の本文は入れない, A1-5）
 * 4. 監査が壊れていても**止まれる**。ただし**解除はできない**（危険な方向だけ fail-closed）
 */

import { FROZEN_NOTICE, createAgent } from "@edv4h/russell-core";
import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { createPgKillSwitchPlugin, readStopState } from "@edv4h/russell-plugin-killswitch-pg";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type {
  AuditSink,
  InboundMessage,
  KillSwitchCapability,
  RussellPlugin,
  Temperament,
} from "@edv4h/russell-shared";
import { KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";

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
  const sent: string[] = [];
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
        async send(o) {
          sent.push(o.text);
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
  return { plugin, sent, push };
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 追記が必ず失敗する sink。監査が壊れている状況を作る。 */
const failingAuditPlugin: RussellPlugin = {
  id: "failing-audit",
  name: "failing audit sink",
  setup(ctx) {
    const sink: AuditSink = {
      id: "failing",
      async write() {
        throw new Error("audit down");
      },
    };
    return ctx.audit.registerSink(sink);
  },
};

const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

describe.skipIf(!DB)("killswitch-pg（DATABASE_URL 必須）", () => {
  const pool = new pg.Pool({ connectionString: DB });
  afterAll(async () => {
    await pool.end();
  });

  test("/russell stop がプロセスを跨いで効き、mention には停止中とだけ返る", async () => {
    const agentId = uniqueId("ks");
    const s = captureSurface();
    const agent = await createAgent(
      { agentId, configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
      [
        createPgAuditPlugin(),
        createPgKillSwitchPlugin(),
        createInMemoryMemoryPlugin(),
        createEchoModelPlugin(),
        s.plugin,
      ],
    );
    const cap = agent.ctx.services.get<KillSwitchCapability>(KILL_SWITCH_SERVICE);
    if (!cap) throw new Error("capability が提供されていない");

    // 稼働中は普通に応答する
    s.push("こんにちは");
    await drain();
    expect(s.sent.length).toBe(1);
    expect(s.sent[0]).not.toBe(FROZEN_NOTICE);

    // 別プロセス（= 別の接続）から発動しても効くことを、DB を直接触って確かめる
    await pool.query(
      `INSERT INTO agent_stops (target, stopped, by_actor, reason)
       VALUES ($1, true, 'u-ops', '誤送信が続いた')`,
      [agentId],
    );

    s.push("まだ動いてる？");
    await drain();
    expect(s.sent.at(-1)).toBe(FROZEN_NOTICE);

    // 解除すれば戻る（同じ個体・同じプロセス）
    await cap.resume({ agentId, scope: "agent", by: "u-ops" });
    s.push("戻った？");
    await drain();
    expect(s.sent.at(-1)).not.toBe(FROZEN_NOTICE);

    await agent.destroy();

    const log = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      "SELECT action, payload FROM event_log WHERE agent_id = $1 ORDER BY id",
      [agentId],
    );
    const actions = log.rows.map((r) => r.action);
    expect(actions).toContain("turn.frozen");
    expect(actions).toContain("killswitch.released");
    // 理由の本文は監査に流さない（A1-5）。DB の agent_stops 側にだけある。
    expect(JSON.stringify(log.rows)).not.toContain("誤送信が続いた");
  });

  test("--all は他の個体にも効く", async () => {
    const alice = uniqueId("ks-alice");
    const bob = uniqueId("ks-bob");
    try {
      await pool.query(
        `INSERT INTO agent_stops (target, stopped, by_actor, reason) VALUES ('*', true, 'u-ops', '全体停止')
         ON CONFLICT (target) DO UPDATE SET stopped = true, by_actor = 'u-ops'`,
      );

      for (const id of [alice, bob]) {
        const state = await readStopState(pool, id);
        expect(state.stopped).toBe(true);
        expect(state.scope).toBe("all"); // 個体単位ではなく全体停止として見える
      }
    } finally {
      // 共有 DB を止めたままにしない（他のテストが凍結される）
      await pool.query("DELETE FROM agent_stops WHERE target = '*'");
    }
    expect((await readStopState(pool, alice)).stopped).toBe(false);
  });

  test("監査が壊れていても止まれる。ただし解除はできない（§12-7）", async () => {
    const agentId = uniqueId("ks-degraded");
    const agent = await createAgent(
      { agentId, configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
      [failingAuditPlugin, createPgKillSwitchPlugin()],
    );
    const cap = agent.ctx.services.get<KillSwitchCapability>(KILL_SWITCH_SERVICE);
    if (!cap) throw new Error("capability が提供されていない");

    // 発動: 監査が残せなくても凍結は成立する（止められない方が危ない）
    const state = await cap.stop({ agentId, scope: "agent", by: "u-ops", reason: "暴走" });
    expect(state.stopped).toBe(true);
    expect((await readStopState(pool, agentId)).stopped).toBe(true);

    // 解除: 誰がいつ解除したか残らないなら解除しない
    await expect(cap.resume({ agentId, scope: "agent", by: "u-ops" })).rejects.toThrow(/監査/);
    expect((await readStopState(pool, agentId)).stopped).toBe(true);

    await agent.destroy();
  });
});
