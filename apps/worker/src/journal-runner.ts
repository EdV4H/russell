/**
 * 日報の実行部（コンソリデーション → 配信）。
 *
 * **CLI と dispatcher の両方から呼ぶ**ので、組み立てをここに寄せてある。
 * 分けていないと「手で流したときは動くが、自動実行では設定が違う」という
 * 差が生まれる——いちばん気づきにくい種類の事故になる。
 */

import {
  DO_NOT_WRITE_PROMPT,
  type PublishStep,
  type RunStatus,
  inspectSensitive,
  runPublication,
  shouldPublishJournal,
} from "@edv4h/russell-core";
import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import {
  type ConsolidationResult,
  type OrganizePlan,
  runConsolidation,
} from "@edv4h/russell-plugin-memory-pg";
import { JOURNAL_CHANNEL_KEY, readSettingWithDefault } from "@edv4h/russell-plugin-settings-pg";
import { createSlackPoster } from "@edv4h/russell-plugin-surface-slack";
import type pg from "pg";
import { resolveModelProvider } from "./model.js";

export type Mode = "off" | "dryrun" | "live";

/**
 * 実行モード（§6.5）。agent と同じ規則で読む。**既定は dryrun**。
 * 解釈できない値は dryrun に倒す（打ち間違いが live にならないように）。
 */
export function resolveMode(): Mode {
  const raw = process.env.RUSSELL_MODE?.trim();
  return raw === "live" || raw === "off" ? raw : "dryrun";
}

/** その日の日報に載る出来事の数。0 なら投稿しない（毎朝「何もなかった」を流さない）。 */
function events(result: ConsolidationResult): number {
  return result.notesConsolidated - result.notesWithheld;
}

export interface JournalRunner {
  consolidate(now: Date, opts?: { dryRun?: boolean }): Promise<ConsolidationResult>;
  publish(
    result: Pick<ConsolidationResult, "entryDate" | "narrative"> & { events: number },
  ): Promise<RunStatus>;
  /** 既にある日記を読む（配信だけやり直す用）。 */
  readJournal(entryDate: string): Promise<{ narrative: string; events: number } | undefined>;
  renderPlan(plan: OrganizePlan): string;
  mode: Mode;
}

export async function createJournalRunner(pool: pg.Pool, agentId: string): Promise<JournalRunner> {
  const mode = resolveMode();
  const agentName = process.env.RUSSELL_AGENT_NAME ?? "Bob";

  // モデルが用意できなければ整理も日記の文章も行わず、決定論的な処理だけが走る。
  // **バッチ全体は止めない**（記録の欠落を作らない）。
  const resolved = resolveModelProvider();
  if (resolved.route === "none") {
    console.warn(
      `[worker] モデル経路がありません（${resolved.reason}）。整理と日記の生成は行いません。`,
    );
  } else {
    console.log(`[worker] モデル経路: ${resolved.route}`);
  }
  const provider = resolved.provider;
  const organize = provider
    ? async (req: { system: string; user: string }) => (await provider.complete(req)).text
    : undefined;

  // **設定（DB）が先、env はフォールバック。** どこへ出すかは Slack から変えられる。
  const journalChannel =
    (await readSettingWithDefault(pool, agentId, JOURNAL_CHANNEL_KEY)) ??
    process.env.RUSSELL_JOURNAL_CHANNEL;

  /** 冪等キー（日付 × 段）を監査から読む。**監査そのものが記録**なので専用テーブルを作らない。 */
  async function prior(entryDate: string, stepId: string) {
    const res = await pool.query<{ status: string }>(
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

  /**
   * Slack へ投稿する段。**装備（Notion 等）を足すときは段を増やす。**
   *
   * poster は段の外で作る。中で作ると設定の誤り（絶対に成功しない失敗）が投稿の例外として
   * `unknown` に化け、二度と再送できなくなる。
   */
  function slackStep(channel: string): PublishStep {
    const poster = createSlackPoster();
    return {
      id: "slack",
      async deliver(ctx) {
        const delivery = await poster.post(channel, `*${ctx.entryDate} の日報*\n${ctx.narrative}`);
        return { status: delivery.status, detail: delivery.detail };
      },
    };
  }

  return {
    mode,

    async consolidate(now, opts = {}) {
      return await runConsolidation({
        agentId,
        now,
        organize,
        narrate: organize,
        screen: (text) => inspectSensitive(text).categories,
        agentName,
        doNotWrite: DO_NOT_WRITE_PROMPT,
        dryRun: opts.dryRun,
        audit: (event) =>
          appendAuditEvent(pool, {
            agentId,
            configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
            actor: agentId,
            action: event.action,
            payload: event.payload,
          }),
      });
    },

    async readJournal(entryDate) {
      const res = await pool.query<{ narrative: string; events: unknown[] }>(
        "SELECT narrative, events FROM journal_entries WHERE agent_id = $1 AND entry_date = $2",
        [agentId, entryDate],
      );
      const row = res.rows[0];
      return row ? { narrative: row.narrative, events: row.events.length } : undefined;
    },

    async publish(result): Promise<RunStatus> {
      const decision = shouldPublishJournal(mode, result.events);
      if (!decision.publish) {
        // **黙って出さないことはしない。** 出さなかった理由が分からないと運用が詰む
        console.log(`[worker] 日報は投稿しません（${decision.reason}）`);
        if (decision.reason !== "empty") {
          console.log(`[worker] 投稿するはずだった内容:\n${result.narrative}`);
        }
        // 出来事が無い日は「正常に処理して報告が無かった」。失敗ではない（§6.2）
        return decision.reason === "empty" ? "succeeded_zero" : "skipped";
      }
      if (!journalChannel) {
        console.log("[worker] 日報の投稿先が未設定のため投稿しません（/russell journal here）。");
        return "skipped";
      }

      // 宛先は段の並び。**Notion に書いて Slack で周知**のような依存も段を足すだけで表せる。
      const reports = await runPublication(
        [slackStep(journalChannel)],
        { entryDate: result.entryDate, narrative: result.narrative },
        {
          prior: (stepId) => prior(result.entryDate, stepId),
          record: (stepId, outcome) =>
            appendAuditEvent(pool, {
              agentId,
              configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
              actor: agentId,
              action: "journal.published",
              // 本文は監査へ入れない（A1-5）
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

      let status: RunStatus = "succeeded";
      for (const r of reports) {
        if (r.status === "skipped" && r.reason === "prior_unknown") {
          console.warn(
            `[worker] ${r.stepId}: 前回の結果が不明のため配信しません（${result.entryDate}）。実際に投稿されているか確認してから、必要なら手で投稿してください。`,
          );
          status = "degraded";
          continue;
        }
        if (r.status !== "succeeded" && r.status !== "skipped") status = "failed";
        console.log(
          `[worker] ${r.stepId}: ${r.status}${r.reason ? `（${r.reason}）` : ""} — ${result.entryDate}`,
        );
      }
      return status;
    },

    renderPlan(plan) {
      const lines: string[] = [];
      for (const m of plan.merges) {
        lines.push(`  畳む: #${m.absorb.join(" #")} → #${m.keep}「${m.title}」`);
        lines.push(`        ${m.card}`);
      }
      for (const r of plan.retitles) lines.push(`  見出し: #${r.id} → 「${r.title}」`);
      return lines.length ? lines.join("\n") : "  （整理するものはありません）";
    },
  };
}
