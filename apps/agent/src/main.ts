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
import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { createPgKillSwitchPlugin } from "@edv4h/russell-plugin-killswitch-pg";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createPgMemoryPlugin } from "@edv4h/russell-plugin-memory-pg";
import { createClaudeModelPlugin } from "@edv4h/russell-plugin-model-claude";
import { createClaudeCodeModelPlugin } from "@edv4h/russell-plugin-model-claude-code";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import { createCliSurfacePlugin } from "@edv4h/russell-plugin-surface-cli";
import { createSlackSurfacePlugin } from "@edv4h/russell-plugin-surface-slack";
import type { RussellPlugin, Temperament } from "@edv4h/russell-shared";

// env に応じて本番プラグイン/オフライン stub を選ぶ。
const useClaude = Boolean(process.env.ANTHROPIC_API_KEY); // ANTHROPIC_API_KEY → 実 Claude、無ければ echo
// 手元の Claude Code CLI をモデルに使う開発用の経路。キーが無くても本物と会話できる。
// **明示的な opt-in のみ**（勝手に CLI プロセスを起動しない）。本番では拒否される。
const useClaudeCode = !useClaude && process.env.RUSSELL_MODEL === "claude-code";
const usePg = Boolean(process.env.DATABASE_URL); // DATABASE_URL → Postgres、無ければインメモリ
const useSlack = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN); // → Slack、無ければ CLI

/** 会話に使うモデル。上から順に「キーがある / 手元の CLI を使う / ダミー」。 */
function modelPlugin(): RussellPlugin {
  if (useClaude) return createClaudeModelPlugin();
  if (useClaudeCode) return createClaudeCodeModelPlugin();
  return createEchoModelPlugin();
}
const MODEL_ID = useClaude ? "claude" : useClaudeCode ? "claude-code" : "echo";

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
 *   audit → killswitch → services/memory → models → surfaces。
 *
 * audit が先頭なのは、以降のプラグインの setup 中に起きる記録も残すため。
 * killswitch がその次なのは、凍結状態が読めるようになってから他を立てるため
 * （通信面が立った時点で `/russell stop` が効く状態になっている）。
 * DATABASE_URL が無い（オフライン stack）ときは通常経路を持たない＝env（レベル3）だけが効く。
 * DATABASE_URL が無い（オフライン stack）ときは sink 無し = コアのインメモリ監査のみになる。
 * 本番構成（Postgres あり）では必ず event_log へ落ちる。
 *
 * pg プラグインは `autoMigrate` を渡さない＝**起動時に DDL を流さない**（§11）。
 * スキーマが未適用なら setup が throw して起動しない（fail-closed）。先に `pnpm migrate` を実行する。
 */
function assembleSpongePlugins(): RussellPlugin[] {
  return [
    ...(usePg ? [createPgAuditPlugin(), createPgKillSwitchPlugin()] : []),
    usePg ? createPgMemoryPlugin() : createInMemoryMemoryPlugin(),
    modelPlugin(),
    useSlack ? createSlackSurfacePlugin() : createCliSurfacePlugin({ displayName: BOB.name }),
  ];
}

async function main(): Promise<void> {
  const agent = await createAgent(
    {
      agentId: "bob",
      configVersion: "v0",
      temperament: BOB,
      mode: "dryrun", // §6.5: off → dryrun → live
      model: MODEL_ID,
    },
    assembleSpongePlugins(),
  );

  // CLI が閉じる（Ctrl-D / EOF）か停止シグナルまで動かし、その後 LIFO で teardown。
  //
  // **SIGTERM も受ける。** プロセスマネージャ（docker stop / systemd / dev-down）が送るのは
  // SIGINT ではなく SIGTERM で、受けていないと既定の即死になる。すると destroy() を通らず、
  // `agent.stopped` が監査に残らないまま消える——記録上「起動したが停止していない個体」が
  // 並び、どこまで動いていたのか後から言えなくなる。
  await new Promise<void>((resolve) => {
    agent.ctx.events.on("surface:cli:closed", () => resolve());
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => resolve());
    }
  });
  await agent.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
