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
import { createAlertsPlugin } from "@edv4h/russell-plugin-alerts";
import { createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import {
  createCalendarEquipmentPlugin,
  createGoogleEquipmentPlugin,
} from "@edv4h/russell-plugin-equipment-google";
import { createNotionEquipmentPlugin } from "@edv4h/russell-plugin-equipment-notion";
import { createPgKillSwitchPlugin } from "@edv4h/russell-plugin-killswitch-pg";
import { createMeetingPlugin } from "@edv4h/russell-plugin-meeting";
import { createBrowserMeetingProvider } from "@edv4h/russell-plugin-meeting-browser";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import { createPgMemoryPlugin } from "@edv4h/russell-plugin-memory-pg";
import { createClaudeModelPlugin } from "@edv4h/russell-plugin-model-claude";
import { createClaudeCodeModelPlugin } from "@edv4h/russell-plugin-model-claude-code";
import { createEchoModelPlugin } from "@edv4h/russell-plugin-model-echo";
import { createPgSettingsPlugin } from "@edv4h/russell-plugin-settings-pg";
import { createCliSurfacePlugin } from "@edv4h/russell-plugin-surface-cli";
import { createSlackSurfacePlugin } from "@edv4h/russell-plugin-surface-slack";
import type { Mode, RussellPlugin } from "@edv4h/russell-shared";
import { type EquipmentId, resolveIndividual, secretFor } from "./individuals.js";

// どの個体を立ち上げるか（§8）。既定は Bob（今までどおり）。
// **知らない名前は落とす**——打ち間違いで別の個体の記憶へ書き込まないため。
const INDIVIDUAL = resolveIndividual(process.env.RUSSELL_AGENT);
const BOB = INDIVIDUAL.temperament;

// env に応じて本番プラグイン/オフライン stub を選ぶ。
const useClaude = Boolean(process.env.ANTHROPIC_API_KEY); // ANTHROPIC_API_KEY → 実 Claude、無ければ echo
// 手元の Claude Code CLI をモデルに使う開発用の経路。キーが無くても本物と会話できる。
// **明示的な opt-in のみ**（勝手に CLI プロセスを起動しない）。本番では拒否される。
const useClaudeCode = !useClaude && process.env.RUSSELL_MODEL === "claude-code";
const usePg = Boolean(process.env.DATABASE_URL); // DATABASE_URL → Postgres、無ければインメモリ
const slackBotToken = secretFor("SLACK_BOT_TOKEN", INDIVIDUAL);
const slackAppToken = secretFor("SLACK_APP_TOKEN", INDIVIDUAL);
const useSlack = Boolean(slackBotToken && slackAppToken); // → Slack、無ければ CLI
// 装備は「支給されていれば持っている」。トークンが無ければプラグイン側が自分で降りるので、
// ここでは常に配列へ入れておく（支給の有無は env が決める, §9.1）。
const useNotion = Boolean(process.env.NOTION_TOKEN);
/** Google の鍵。**リフレッシュトークンだけが個体ごと**（クライアントは共有, #123）。 */
const googleToken = secretFor("GOOGLE_REFRESH_TOKEN", INDIVIDUAL);

/** 会話に使うモデル。上から順に「キーがある / 手元の CLI を使う / ダミー」。 */
function modelPlugin(): RussellPlugin {
  if (useClaude) return createClaudeModelPlugin();
  if (useClaudeCode) return createClaudeCodeModelPlugin();
  return createEchoModelPlugin();
}
const MODEL_ID = useClaude ? "claude" : useClaudeCode ? "claude-code" : "echo";

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
  /** その個体に支給されているか。**支給の意思**を見る（鍵の有無は各プラグインが見る）。 */
  const issued = (id: EquipmentId) => INDIVIDUAL.equipment.includes(id);

  return [
    ...(usePg ? [createPgAuditPlugin(), createPgKillSwitchPlugin(), createPgSettingsPlugin()] : []),
    usePg ? createPgMemoryPlugin() : createInMemoryMemoryPlugin(),
    // **支給する装備だけを組み立てる**（§9.1）。載っていないものは作りもしない——
    // 個体は持っていない能力の存在を知らない（§9.2）。
    // 載っていても鍵が無ければ、プラグイン側が自分で降りる。
    ...(issued("notion") && useNotion ? [createNotionEquipmentPlugin()] : []),
    // **Google の鍵も個体ごと。** クライアントは共有だが、リフレッシュトークンが
    // 「誰として読むか」を決める——共有すると、秘書が新人の Drive を読むことになる
    ...(issued("google-drive") ? [createGoogleEquipmentPlugin({ refreshToken: googleToken })] : []),
    ...(issued("google-calendar")
      ? [createCalendarEquipmentPlugin({ refreshToken: googleToken })]
      : []),
    // 会議。**入る経路が無ければ、装備そのものが支給されない**（#130）。
    // 経路はブラウザで、ログイン済みのプロファイル（`RUSSELL_MEET_PROFILE`）が要る。
    ...(issued("meeting")
      ? [createMeetingPlugin({ provider: createBrowserMeetingProvider() })]
      : []),
    modelPlugin(),
    useSlack
      ? // **個体ごとの鍵を渡す。** 同じトークンを共有すると、2つの個体が同じ名前で喋る
        createSlackSurfacePlugin({ botToken: slackBotToken, appToken: slackAppToken })
      : createCliSurfacePlugin({ displayName: BOB.name }),
    // **最後に置く。** 安全系イベントの購読なので、他のプラグインの setup 中に起きたものは
    // 拾えない——それでも構わない。ここが拾いたいのは「動き出した後に壊れたとき」である。
    createAlertsPlugin(),
  ];
}

/**
 * 実行モード（§6.5）。**既定は dryrun**——安全側から始める。
 *
 * dryrun では外部への送信を止める（Slack に返信しない）。本番ワークスペースへ繋ぐ前に
 * 挙動を確かめるための段階で、`RUSSELL_MODE=live` を明示して初めて喋る。
 * 未知の値は dryrun に倒す（打ち間違いが live にならないように）。
 */
function resolveMode(): Mode {
  const raw = process.env.RUSSELL_MODE?.trim();
  if (raw === "live" || raw === "off") return raw;
  if (raw && raw !== "dryrun") {
    console.warn(`[agent] RUSSELL_MODE="${raw}" は解釈できません。dryrun で起動します。`);
  }
  return "dryrun";
}

/**
 * ログに出す居場所。**そのまま Slack で開ける形**にする。
 *
 * contextId（チャンネル:スレッド）だけだと「このスレッドで黙った」までしか分からず、
 * どの発言に対する判断かを追えない（実際に追えなかった）。Slack のパーマリンクは
 * `.../archives/<channel>/p<ドットを抜いた ts>` なので、その形で出す。
 */
function where(p: { surfaceId: string; contextId: string; messageId?: string }): string {
  if (!p.messageId) return p.contextId;
  if (p.surfaceId !== "slack") return `${p.contextId} / ${p.messageId}`;
  const channel = p.contextId.split(":")[0];
  return `${channel}/p${p.messageId.replace(".", "")}`;
}

async function main(): Promise<void> {
  const agent = await createAgent(
    {
      agentId: INDIVIDUAL.id,
      configVersion: "v0",
      temperament: BOB,
      mode: resolveMode(), // §6.5: off → dryrun → live
      model: MODEL_ID,
    },
    assembleSpongePlugins(),
  );

  // **黙った理由が見えないと調整できない。** 3人以上のスレッドで、宛先も話題も自分ではないと
  // 判断したときだけ出る（決定論で即決した分は出ない）。本文は出さない（A1-5）。
  const JUDGEMENT_LABEL = { reply: "返す", react: "印だけ付ける", silent: "黙る" } as const;
  type Judged = {
    surfaceId: string;
    contextId: string;
    messageId?: string;
    judgement: keyof typeof JUDGEMENT_LABEL;
  };
  agent.ctx.events.on<Judged>("reply:judged", (p) => {
    console.log(`[reply] ${JUDGEMENT_LABEL[p.judgement] ?? p.judgement}（${where(p)}）`);
  });
  agent.ctx.events.on<Omit<Judged, "judgement"> & { error: string }>("reply:judge-failed", (p) => {
    console.warn(`[reply] 判定できなかったので黙ります（${where(p)}）: ${p.error}`);
  });

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
