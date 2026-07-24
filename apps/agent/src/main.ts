/**
 * 組み立てホスト（composition root）。
 * usketch の apps/web/app.tsx が createBasePlugins() でプラグイン配列を組むのと同じ役割を、
 * Russell では「プリセット」が担う（docs/guides/24-defining-a-preset.md）。
 *
 * ここでは個体1号 Bob（スポンジプリセット）の最小組み立てを示す。
 * P0 実装では acme の代わりに surface-slack / memory-pg / model-claude を並べる。
 */

import { createAgent } from "@edv4h/russell-core";
import { createAcmeSurfacePlugin } from "@edv4h/russell-plugin-acme-surface";
import type { RussellPlugin, Temperament } from "@edv4h/russell-shared";

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
 *   services/memory → models → equipment → surfaces → routines → findings
 * P0 では surface だけを acme で代用（実装時に差し替え）。
 */
function assembleSpongePlugins(): RussellPlugin[] {
  return [
    // TODO(P0): createPgMemoryPlugin(), createClaudeModelPlugin() をここに（surface より前）
    createAcmeSurfacePlugin({ greeting: "はじめまして、Bob です。" }),
  ];
}

async function main(): Promise<void> {
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      mode: "dryrun", // §6.5: off → dryrun → live
    },
    assembleSpongePlugins(),
  );

  console.log(
    `Russell agent up: ${agent.ctx.runtime.agentId} (mode=${agent.ctx.runtime.mode()}, kill=${agent.ctx.runtime.killSwitch()})`,
  );
  console.log(
    `surfaces: ${agent.ctx.surfaces
      .getAll()
      .map((s) => s.id)
      .join(", ")}`,
  );

  // TODO(P0): 認知ループ起動後は SIGINT/SIGTERM で agent.destroy() を呼ぶ
  await agent.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
