/**
 * 日報の配信（§10.1）。**宛先は1つとは限らない。**
 *
 * 想定している形は3つあり、どれも「段の並び」で表せる:
 * - Slack に投稿する（1段）
 * - Notion に投稿する（1段。ただし効果分類は `external_write`）
 * - **Notion に書いて、その URL を Slack で周知する**（2段。前段の出力を後段が使う）
 *
 * 3つ目が構造として新しい。単なる並列配信ではなく、**前段の結果に依存する**ので、
 * 出力を後段へ渡す形が要る。
 *
 * ここは順序と冪等性だけを見る純粋な組み立て。実際に何をするかは各段（`deliver`）に閉じる。
 */

import type { OperationResult } from "@edv4h/russell-shared";

/** 前段までの結果。後段はここから URL などを受け取る。 */
export interface PublishContext {
  entryDate: string;
  narrative: string;
  /** 段の id → その段の出力（Notion のページ URL など）。 */
  outputs: Record<string, string>;
}

export interface PublishOutcome {
  status: OperationResult;
  detail?: string;
  /** 後段が使える出力。URL など。 */
  output?: string;
}

/** 配信の1段。Slack への投稿、Notion への書き込み、などが1つずつ入る。 */
export interface PublishStep {
  /** 監査と冪等判定のキーになる。段を入れ替えても意味が変わらない名前にする。 */
  id: string;
  deliver(ctx: PublishContext): Promise<PublishOutcome>;
}

/** 段ごとの結果。**やらなかった理由も残す**（黙って配らないのが一番困る）。 */
export interface StepReport {
  stepId: string;
  status: OperationResult | "skipped";
  reason?: "already_published" | "prior_unknown" | "upstream_failed";
  detail?: string;
}

export interface PublicationDeps {
  /**
   * その段が**この日付で既に実行されているか**。冪等キーは（日付 × 段）。
   *
   * 返り値は前回の結果そのもの。`unknown` の扱いが要点で、**blind retry は禁止**（§9.2）。
   */
  prior?(stepId: string): Promise<OperationResult | undefined>;
  /** 実行結果を残す（監査）。冪等判定はここに残ったものを読む。 */
  record?(stepId: string, outcome: PublishOutcome): Promise<void>;
}

/**
 * 段を順に実行する。
 *
 * - **前段が succeeded でなければ後段を走らせない。** 「Notion に書けていないのに
 *   Slack で周知する」が最悪の失敗なので、安全側は止まる方。
 *   （互いに独立した宛先を並列に配りたくなったら、段に依存関係を持たせて分ける）
 * - 既に succeeded の段は飛ばす。日付キーで再実行できるのが日報の前提（§4）
 * - **前回が unknown の段は飛ばして報告する。** 二重投稿の方が害が大きく、
 *   自動で解決してよい状況ではない（§9.2）
 */
export async function runPublication(
  steps: PublishStep[],
  base: Omit<PublishContext, "outputs">,
  deps: PublicationDeps = {},
): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  const outputs: Record<string, string> = {};
  let blocked = false;

  for (const step of steps) {
    if (blocked) {
      reports.push({ stepId: step.id, status: "skipped", reason: "upstream_failed" });
      continue;
    }
    const prior = await deps.prior?.(step.id);
    if (prior === "succeeded") {
      reports.push({ stepId: step.id, status: "skipped", reason: "already_published" });
      continue;
    }
    if (prior === "unknown") {
      // 前回の結果が分からない。**もう一度投げない**——二重投稿は取り消せない
      reports.push({ stepId: step.id, status: "skipped", reason: "prior_unknown" });
      blocked = true;
      continue;
    }

    let outcome: PublishOutcome;
    try {
      outcome = await step.deliver({ ...base, outputs });
    } catch (err) {
      // 例外は「結果不明」に倒す。成功したかもしれないので rejected とは言えない
      outcome = { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
    }
    await deps.record?.(step.id, outcome);
    if (outcome.output) outputs[step.id] = outcome.output;
    reports.push({ stepId: step.id, status: outcome.status, detail: outcome.detail });
    if (outcome.status !== "succeeded") blocked = true;
  }

  return reports;
}
