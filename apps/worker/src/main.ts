/**
 * worker プロセス（§2: app と分離）。夜間コンソリデーション（§4）を1回実行する。
 *
 * 本番では pg-boss の cron（§11）で 03:00 JST に定期起動し、生成した日記を
 * #<個体名>-日報 に投稿する（§10.1）。ここでは1回実行して日報テキストを出力するところまで。
 *
 * 要 DATABASE_URL（app と同じ Postgres を参照）。
 *
 * 使い方:
 *   pnpm consolidate              # 実行する（今日の分）
 *   pnpm consolidate --dry-run    # 本棚をどう整理するかだけ見せる（DB は変えない）
 *   pnpm consolidate --backfill   # 未処理のメモが残っている日を、古い順に1日ずつ書く
 */

import {
  DO_NOT_WRITE_PROMPT,
  type PublishStep,
  inspectSensitive,
  runPublication,
  shouldPublishJournal,
} from "@edv4h/russell-core";
import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import { isFrozen } from "@edv4h/russell-plugin-killswitch-pg";
import {
  type ConsolidationResult,
  type OrganizePlan,
  runConsolidation,
} from "@edv4h/russell-plugin-memory-pg";
import { createClaudeCodeProvider } from "@edv4h/russell-plugin-model-claude-code";
import { JOURNAL_CHANNEL_KEY, readSettingWithDefault } from "@edv4h/russell-plugin-settings-pg";
import { createSlackPoster } from "@edv4h/russell-plugin-surface-slack";
import pg from "pg";

/** その日の日報に載る出来事の数。0 なら投稿しない（毎朝「何もなかった」を流さない）。 */
function events(result: ConsolidationResult): number {
  return result.notesConsolidated - result.notesWithheld;
}

/**
 * 実行モード（§6.5）。agent と同じ規則で読む。**既定は dryrun**。
 * 解釈できない値は dryrun に倒す（打ち間違いが live にならないように）。
 */
function resolveMode(): "off" | "dryrun" | "live" {
  const raw = process.env.RUSSELL_MODE?.trim();
  if (raw === "live" || raw === "off") return raw;
  return "dryrun";
}

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
  /**
   * 走らせ損ねた日を埋める。**自動起動がまだ無い**ので、手で流すまで日記は書かれない。
   * 1日ずつ書くのは、複数日分を1つの日記に混ぜないため（日記はエピソード記憶で、
   * 「いつの話か」が失われると意味が薄れる）。
   */
  const backfill = process.argv.includes("--backfill");

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
  /** 日記の文章もモデルで書く（§4-1）。同じ provider を使い回す。 */
  const narrate = organize;
  /** 生成後の二次フィルタ（A-1）。判定はコアが持っているので注入で渡す。 */
  const screen = (text: string) => inspectSensitive(text).categories;
  const agentName = process.env.RUSSELL_AGENT_NAME ?? "Bob";
  /**
   * 日報の投稿先（§10.1）。**未設定なら投稿しない。**
   * 「どこへ出すか」は運用が決めることなので、既定でどこかへ流し始めない。
   */
  /** worker も実行モードに従う（§6.5）。投稿は external_send なので dryrun では出さない。 */
  const mode = resolveMode();

  /**
   * その段が**この日付で既に実行されたか**を監査から読む（冪等キー = 日付 × 段）。
   *
   * 専用のテーブルを作らないのは、**監査そのものが「何が起きたか」の記録**だから。
   * 二重に持つと必ずズレる。
   */
  async function priorResult(entryDate: string, stepId: string) {
    const res = await auditPool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM event_log
        WHERE agent_id = $1 AND action = 'journal.published'
          AND payload->>'entryDate' = $2 AND payload->>'step' = $3
        ORDER BY ts DESC LIMIT 1`,
      [agentId, entryDate, stepId],
    );
    const status = res.rows[0]?.status;
    return status === "succeeded" || status === "unknown" || status === "rejected"
      ? status
      : undefined;
  }

  /** Slack へ日報を投稿する段。**装備（Notion 等）を足すときは、ここに段を増やす。** */
  function slackStep(channel: string): PublishStep {
    return {
      id: "slack",
      async deliver(ctx) {
        const delivery = await createSlackPoster().post(
          channel,
          `*${ctx.entryDate} の日報*\n${ctx.narrative}`,
        );
        return { status: delivery.status, detail: delivery.detail };
      },
    };
  }

  /** 日報を配信する。投稿したか・しなかった理由は必ず記録する。 */
  async function publish(result: ConsolidationResult): Promise<void> {
    const decision = shouldPublishJournal(mode, events(result));
    if (!decision.publish) {
      // **黙って出さないことはしない。** 出さなかった理由が分からないと運用が詰む
      console.log(`[worker] 日報は投稿しません（${decision.reason}）`);
      if (decision.reason === "mode_dryrun" || decision.reason === "mode_off") {
        console.log(`[worker] 投稿するはずだった内容:\n${result.narrative}`);
      }
      return;
    }
    if (!journalChannel) {
      console.log("[worker] RUSSELL_JOURNAL_CHANNEL が未設定のため投稿しません。");
      return;
    }
    // 宛先は段の並び。いまは Slack 1段だが、**Notion に書いて Slack で周知**のような
    // 依存のある配信も、段を足すだけで表せる形にしてある。
    const steps: PublishStep[] = [slackStep(journalChannel)];

    const reports = await runPublication(
      steps,
      { entryDate: result.entryDate, narrative: result.narrative },
      {
        prior: (stepId) => priorResult(result.entryDate, stepId),
        // 投稿は外部への送信。**本文は監査へ入れない**（A1-5）
        record: (stepId, outcome) =>
          appendAuditEvent(auditPool, {
            agentId,
            configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
            actor: agentId,
            action: "journal.published",
            payload: {
              entryDate: result.entryDate,
              step: stepId,
              status: outcome.status,
              length: result.narrative.length,
            },
            trustLabel: "trusted",
          }),
      },
    );

    for (const r of reports) {
      if (r.status === "skipped" && r.reason === "prior_unknown") {
        // **自動では解決しない。** 前回投稿できたか分からない状態で投げ直すと二重投稿になる
        console.warn(
          `[worker] ${r.stepId}: 前回の結果が不明のため配信しません（${result.entryDate}）。実際に投稿されているか確認してから、必要なら手で投稿してください。`,
        );
        continue;
      }
      console.log(
        `[worker] ${r.stepId}: ${r.status}${r.reason ? `（${r.reason}）` : ""} — ${result.entryDate}`,
      );
    }
  }

  // 監査は worker 自身のプールで残す（コアの AuditRegistry はこのプロセスに無い）。
  const auditPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  auditPool.on("error", (err) => {
    console.error("[worker] 監査用 Postgres 接続エラー:", err.message);
  });

  // **設定（DB）が先、env はフォールバック。** どこへ出すかは Slack から変えられる
  // （`/russell journal here`）ので、env で固定するものではない。
  const journalChannel =
    (await readSettingWithDefault(auditPool, agentId, JOURNAL_CHANNEL_KEY)) ??
    process.env.RUSSELL_JOURNAL_CHANNEL;

  try {
    if (backfill) {
      const days = await auditPool.query<{ d: string }>(
        `SELECT DISTINCT created_at::date::text AS d FROM notes
          WHERE agent_id = $1 AND consolidated = false ORDER BY d ASC`,
        [agentId],
      );
      if (days.rowCount === 0) {
        console.log("[worker] 未処理のメモはありません。");
        return;
      }
      for (const { d } of days.rows) {
        const r = await runConsolidation({
          agentId,
          // その日の 12:00 UTC を基準にする。日付キーだけが効くので時刻は何でもよいが、
          // 日境界から離しておく方が事故が少ない
          now: new Date(`${d}T12:00:00Z`),
          organize,
          narrate,
          screen,
          agentName,
          doNotWrite: DO_NOT_WRITE_PROMPT,
          audit: (event) =>
            appendAuditEvent(auditPool, {
              agentId,
              configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
              actor: agentId,
              action: event.action,
              payload: event.payload,
            }),
        });
        console.log(
          `[worker] ${r.entryDate}: notes=${r.notesConsolidated} withheld=${r.notesWithheld} ` +
            `promoted=${r.booksPromoted} merged=${r.booksMerged}`,
        );
        console.log(`  [日報] ${r.narrative}`);
        await publish(r);
      }
      return;
    }

    // autoMigrate は渡さない＝起動時に DDL を流さない（§11）。未適用なら throw して止まる。
    const result = await runConsolidation({
      agentId,
      organize,
      narrate,
      screen,
      agentName,
      doNotWrite: DO_NOT_WRITE_PROMPT,
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
      if (result.promotions.length) {
        console.log("[worker] メモから昇格させる本:");
        for (const p of result.promotions) {
          console.log(`  昇格: メモ #${p.noteIds.join(" #")} → 「${p.title}」`);
          console.log(`        ${p.card}`);
        }
      } else {
        console.log("[worker] 昇格するメモはありません。");
      }
      console.log("[worker] 本棚の整理の計画:");
      console.log(renderPlan(result.plan));
      return;
    }

    console.log(
      `[worker] consolidation ${result.entryDate}: notes=${result.notesConsolidated} ` +
        `promoted=${result.booksPromoted}(notes=${result.notesPromoted}) ` +
        `merged=${result.booksMerged} absorbed=${result.booksAbsorbed} ` +
        `retitled=${result.booksRetitled} decayed=${result.booksDecayed} archived=${result.booksArchived}`,
    );
    console.log(`[日報] ${result.narrative}`);
    await publish(result);
  } finally {
    await auditPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
