/**
 * 組み立てホスト（composition root）。
 * usketch の apps/web/app.tsx がプラグイン配列を組むのと同じ役割を、Russell では「プリセット」が担う。
 *
 * ここでは個体1号 Bob（スポンジ）を **オフライン stack** で組み立てる:
 *   memory-inmem（Postgres不要）＋ model-echo（APIキー不要）＋ surface-cli（Slack不要）
 * env 無しで認知ループ（mention→記憶→モデル→Policy Gate通過のツール→応答）を検証できる。
 * 本番では memory-pg / model-claude / surface-slack に差し替える（契約は同じ）。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createPgMemoryPlugin } from "@edv4h/russell-plugin-memory-pg";
import { createClaudeModelPlugin } from "@edv4h/russell-plugin-model-claude";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import { createCliSurfacePlugin } from "@edv4h/russell-plugin-surface-cli";
import type { RussellPlugin, Temperament } from "@edv4h/russell-shared";

// env に応じて本番プラグイン/オフライン stub を選ぶ。
const useClaude = Boolean(process.env.ANTHROPIC_API_KEY); // ANTHROPIC_API_KEY → 実 Claude、無ければ echo
const usePg = Boolean(process.env.DATABASE_URL); // DATABASE_URL → Postgres、無ければインメモリ

// 個体1号 Bob（docs/preparation/initial-data/temperament-unit-01.md の確定値）
const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧だが硬すぎない。明るく前向き。わからないことは素直に聞く。絵文字は控えめ",
  backstory: "好奇心旺盛で、何でもスポンジのように吸収する新人。半年後にジェネラリストへ",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/**
 * スポンジプリセットが Bob 用に組むプラグイン配列。
 * 配列順は load-bearing（provider を consumer より前に）:
 *   services/memory → models → surfaces。
 */
function assembleSpongePlugins(): RussellPlugin[] {
  return [
    usePg ? createPgMemoryPlugin({ autoMigrate: true }) : createInMemoryMemoryPlugin(),
    useClaude ? createClaudeModelPlugin() : createEchoModelPlugin(),
    createCliSurfacePlugin({ displayName: BOB.name }),
  ];
}

async function main(): Promise<void> {
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      mode: "dryrun", // §6.5: off → dryrun → live
      model: useClaude ? "claude" : "echo",
    },
    assembleSpongePlugins(),
  );

  // CLI が閉じる（Ctrl-D / EOF）か SIGINT まで動かし、その後 LIFO で teardown。
  await new Promise<void>((resolve) => {
    agent.ctx.events.on("surface:cli:closed", () => resolve());
    process.on("SIGINT", () => resolve());
  });
  await agent.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
