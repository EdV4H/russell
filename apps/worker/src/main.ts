/**
 * worker プロセス（§2: app と分離）。夜間コンソリデーション（§4）を1回実行する。
 *
 * 本番では pg-boss の cron（§11）で 03:00 JST に定期起動し、生成した日記を
 * #<個体名>-日報 に投稿する（§10.1）。ここでは1回実行して日報テキストを出力するところまで。
 *
 * 要 DATABASE_URL（app と同じ Postgres を参照）。
 */

import { isFrozen } from "@edv4h/russell-plugin-killswitch-pg";
import { runConsolidation } from "@edv4h/russell-plugin-memory-pg";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[worker] DATABASE_URL が未設定です。app と同じ Postgres を指してください。");
    process.exit(1);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";

  // 夜間バッチは自発行動そのものなので、凍結中は走らせない（§12-4）。
  // app とは別プロセス＝別経路なので、ここでも独立に確かめる必要がある。
  if (await isFrozen(agentId)) {
    console.log("[worker] キルスイッチ発動中のためコンソリデーションを実行しません。");
    return;
  }
  // autoMigrate は渡さない＝起動時に DDL を流さない（§11）。未適用なら throw して止まる。
  const result = await runConsolidation({ agentId });

  console.log(
    `[worker] consolidation ${result.entryDate}: notes=${result.notesConsolidated} decayed=${result.booksDecayed} archived=${result.booksArchived}`,
  );
  // この narrative を #<個体名>-日報 に投稿するのが §10.1（surface 経由）。
  console.log(`[日報] ${result.narrative}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
