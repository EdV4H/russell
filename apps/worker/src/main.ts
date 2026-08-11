/**
 * worker プロセス（§2: app と分離）。夜間コンソリデーション（§4）を1回実行する。
 *
 * 本番では pg-boss の cron（§11）で 03:00 JST に定期起動し、生成した日記を
 * #<個体名>-日報 に投稿する（§10.1）。ここでは1回実行して日報テキストを出力するところまで。
 *
 * 要 DATABASE_URL（app と同じ Postgres を参照）。
 *
 * 使い方:
 *   pnpm consolidate              # 実行する
 *   pnpm consolidate --dry-run    # 本棚をどう整理するかだけ見せる（DB は変えない）
 */

import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import { isFrozen } from "@edv4h/russell-plugin-killswitch-pg";
import { type OrganizePlan, runConsolidation } from "@edv4h/russell-plugin-memory-pg";
import { createClaudeCodeProvider } from "@edv4h/russell-plugin-model-claude-code";
import pg from "pg";

/** 計画を人が読める形にする。dry-run はこれを見て判断してもらうためにある。 */
function renderPlan(plan: OrganizePlan): string {
  const lines: string[] = [];
  for (const m of plan.merges) {
    lines.push(`  畳む: #${m.absorb.join(" #")} → #${m.keep}「${m.title}」`);
    lines.push(`        ${m.card}`);
  }
  for (const r of plan.retitles) {
    lines.push(`  見出し: #${r.id} → 「${r.title}」`);
  }
  return lines.length ? lines.join("\n") : "  （整理するものはありません）";
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[worker] DATABASE_URL が未設定です。app と同じ Postgres を指してください。");
    process.exit(1);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const dryRun = process.argv.includes("--dry-run");

  // 夜間バッチは自発行動そのものなので、凍結中は走らせない（§12-4）。
  // app とは別プロセス＝別経路なので、ここでも独立に確かめる必要がある。
  if (await isFrozen(agentId)) {
    console.log("[worker] キルスイッチ発動中のためコンソリデーションを実行しません。");
    return;
  }

  // 本棚の整理に使うモデル（§4-3）。用意できなければ整理は行わず、
  // 決定論的な処理（日記・忘却）だけが走る。**バッチ全体は止めない。**
  let organize: ((req: { system: string; user: string }) => Promise<string>) | undefined;
  try {
    const provider = createClaudeCodeProvider({
      model: process.env.RUSSELL_MEMORY_MODEL ?? "sonnet",
    });
    organize = async (req) => (await provider.complete(req)).text;
  } catch (err) {
    console.warn(`[worker] 本棚の整理はモデルが用意できないため行いません: ${String(err)}`);
  }

  // 監査は worker 自身のプールで残す（コアの AuditRegistry はこのプロセスに無い）。
  const auditPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  auditPool.on("error", (err) => {
    console.error("[worker] 監査用 Postgres 接続エラー:", err.message);
  });

  try {
    // autoMigrate は渡さない＝起動時に DDL を流さない（§11）。未適用なら throw して止まる。
    const result = await runConsolidation({
      agentId,
      organize,
      dryRun,
      audit: (event) =>
        appendAuditEvent(auditPool, {
          agentId,
          configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
          actor: agentId,
          action: event.action,
          payload: event.payload,
        }),
    });

    if (dryRun) {
      console.log(
        `[worker] --dry-run: DB は変更していません。実行すると notes=${result.notesConsolidated} ` +
          `decayed=${result.booksDecayed} archived=${result.booksArchived}`,
      );
      console.log("[worker] 本棚の整理の計画:");
      console.log(renderPlan(result.plan));
      return;
    }

    console.log(
      `[worker] consolidation ${result.entryDate}: notes=${result.notesConsolidated} ` +
        `merged=${result.booksMerged} absorbed=${result.booksAbsorbed} ` +
        `retitled=${result.booksRetitled} decayed=${result.booksDecayed} archived=${result.booksArchived}`,
    );
    // この narrative を #<個体名>-日報 に投稿するのが §10.1（surface 経由）。
    console.log(`[日報] ${result.narrative}`);
  } finally {
    await auditPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
