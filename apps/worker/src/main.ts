/**
 * worker の CLI（§2: app と分離）。夜間コンソリデーション（§4）を手で流す口。
 *
 * **定期実行は dispatcher が持つ**（`dispatch.ts`）。ここは手動の操作と、
 * 自動実行が詰まったときの復旧のために残してある。
 *
 *   pnpm consolidate                       # 今日の分
 *   pnpm consolidate --dry-run             # DB を変えずに、何をするかだけ見せる
 *   pnpm consolidate --backfill            # 未処理のメモが残っている日を古い順に
 *   pnpm consolidate --publish 2026-08-11  # 既にある日記を配信だけやり直す
 *
 * 前回の結果が `unknown` の日は自動で再送しない（§9.2）。人が確かめて決着を付ける:
 *   pnpm consolidate --resolve 2026-08-11 --not-sent  # 届いていなかった → 再送できる
 *   pnpm consolidate --resolve 2026-08-11 --sent      # 届いていた → 配信済みとして閉じる
 */

import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import { isFrozen } from "@edv4h/russell-plugin-killswitch-pg";
import pg from "pg";
import { createJournalRunner } from "./journal-runner.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[worker] DATABASE_URL が未設定です。app と同じ Postgres を指してください。");
    process.exit(1);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const dryRun = process.argv.includes("--dry-run");
  const backfill = process.argv.includes("--backfill");
  const publishOnly = flag("--publish");
  const resolveDate = flag("--resolve");

  // 夜間バッチは自発行動そのものなので、凍結中は走らせない（§12-4）。
  // app とは別プロセス＝別経路なので、ここでも独立に確かめる。
  if (await isFrozen(agentId)) {
    console.log("[worker] キルスイッチ発動中のためコンソリデーションを実行しません。");
    return;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (err) => console.error("[worker] Postgres 接続エラー:", err.message));

  try {
    // 結果不明（unknown）の決着を人が付ける。**自動では解決しない**のがこの機構の要点。
    if (resolveDate) {
      const sent = process.argv.includes("--sent");
      const notSent = process.argv.includes("--not-sent");
      if (sent === notSent) {
        console.error("[worker] 使い方: --resolve <YYYY-MM-DD> --sent|--not-sent（どちらか一方）");
        process.exit(64);
      }
      await appendAuditEvent(pool, {
        agentId,
        configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
        actor: process.env.RUSSELL_OPERATOR ?? "operator",
        action: "journal.published",
        payload: {
          entryDate: resolveDate,
          step: "slack",
          // 届いていなかった＝送っていないのと同じ。次の配信で送り直せる
          status: sent ? "succeeded" : "rejected",
          resolvedByHuman: true,
        },
        trustLabel: "trusted",
      });
      console.log(
        sent
          ? `[worker] ${resolveDate} は配信済みとして閉じました。`
          : `[worker] ${resolveDate} は未配信として記録しました。--publish ${resolveDate} で送り直せます。`,
      );
      return;
    }

    const runner = await createJournalRunner(pool, agentId);

    if (publishOnly) {
      const journal = await runner.readJournal(publishOnly);
      if (!journal) {
        console.log(`[worker] ${publishOnly} の日記がありません。`);
        return;
      }
      await runner.publish({ entryDate: publishOnly, ...journal });
      return;
    }

    if (backfill) {
      const days = await pool.query<{ d: string }>(
        `SELECT DISTINCT created_at::date::text AS d FROM notes
          WHERE agent_id = $1 AND consolidated = false ORDER BY d ASC`,
        [agentId],
      );
      if (days.rowCount === 0) {
        console.log("[worker] 未処理のメモはありません。");
        return;
      }
      for (const { d } of days.rows) {
        // 日境界から離した時刻を基準にする（日付キーだけが効くので時刻は何でもよい）
        const r = await runner.consolidate(new Date(`${d}T12:00:00Z`));
        console.log(
          `[worker] ${r.entryDate}: notes=${r.notesConsolidated} withheld=${r.notesWithheld} promoted=${r.booksPromoted} merged=${r.booksMerged}`,
        );
        await runner.publish({
          entryDate: r.entryDate,
          narrative: r.narrative,
          events: r.notesConsolidated - r.notesWithheld,
        });
      }
      return;
    }

    const result = await runner.consolidate(new Date(), { dryRun });
    if (dryRun) {
      console.log(
        `[worker] --dry-run: DB は変更していません。実行すると notes=${result.notesConsolidated} decayed=${result.booksDecayed} archived=${result.booksArchived}`,
      );
      if (result.promotions.length) {
        console.log("[worker] メモから昇格させる本:");
        for (const p of result.promotions) {
          console.log(`  昇格: メモ #${p.noteIds.join(" #")} → 「${p.title}」`);
        }
      }
      console.log("[worker] 本棚の整理の計画:");
      console.log(runner.renderPlan(result.plan));
    } else {
      console.log(
        `[worker] consolidation ${result.entryDate}: notes=${result.notesConsolidated} promoted=${result.booksPromoted} merged=${result.booksMerged} decayed=${result.booksDecayed}`,
      );
    }
    console.log(`[日報] ${result.narrative}`);
    await runner.publish({
      entryDate: result.entryDate,
      narrative: result.narrative,
      events: result.notesConsolidated - result.notesWithheld,
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
