/**
 * DB 接続が切れたときにプロセスが死なないこと。Postgres が要る（DATABASE_URL）。
 *
 * `pg.Pool` は `error` リスナが無いと、**idle 接続が切れただけで**
 * unhandled 'error' event になりプロセスごと落ちる。DB の再起動・フェイルオーバ・
 * `pg_terminate_backend` のたびに個体が死ぬので、監視の再起動ループにも入りうる。
 *
 * fail-closed（§12-7）は「危険な側に倒さない」であって「落ちる」ではない。落ちるべきは
 * 判定であって、プロセスではない。ここでは接続を外から切って、
 * **落ちずに再接続して応答へ戻る**ことを確かめる。
 */

import { createAgent } from "@edv4h/russell-core";
import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { createPgKillSwitchPlugin } from "@edv4h/russell-plugin-killswitch-pg";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import type { InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
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
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, sent, push };
}

async function waitForSends(sent: string[], n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`送信が ${n} 件に達しませんでした（${sent.length} 件）`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!DB)("Postgres 接続の切断耐性（DATABASE_URL 必須）", () => {
  const admin = new pg.Pool({ connectionString: DB });
  afterAll(async () => {
    await admin.end();
  });

  test("接続を外から切られても落ちず、再接続して応答に戻る", async () => {
    // この個体のプール接続だけを狙って切るための目印。共有 DB の他の接続は巻き込まない。
    const appName = `russell-resilience-${process.pid}`;
    const dsn = `${DB}${DB?.includes("?") ? "&" : "?"}application_name=${appName}`;

    const s = captureSurface();
    const agent = await createAgent(
      { agentId: `resil-${process.pid}`, configVersion: "v0", temperament: BOB, model: "echo" },
      [
        createPgAuditPlugin({ connectionString: dsn }),
        createPgKillSwitchPlugin({ connectionString: dsn }),
        createInMemoryMemoryPlugin(),
        createEchoModelPlugin(),
        s.plugin,
      ],
    );

    s.push("こんにちは");
    await waitForSends(s.sent, 1);

    // DB 再起動・フェイルオーバ相当。idle 接続が切られる＝リスナが無ければここで落ちる。
    const killed = await admin.query<{ pg_terminate_backend: boolean }>(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [appName],
    );
    expect(killed.rowCount).toBeGreaterThan(0); // 実際に切れていないとテストにならない
    await new Promise((r) => setTimeout(r, 300)); // 切断がプールに届くのを待つ

    s.push("生きてる？");
    await waitForSends(s.sent, 2);

    await agent.destroy();
  });
});
