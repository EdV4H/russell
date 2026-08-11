/**
 * 機微情報の印を付け直す（A-1 / ADR 0007）。
 *
 * **判定リストは必ず育つ。** 実際、企画書の機能名「特性診断」が健康カテゴリに当たって、
 * メモ2件が日記から不当に外された。リストを直したら、**既に付いた印も直さないと
 * 意味がない**——印は保存されていて、次回以降の判定では作り直されないので。
 *
 *   pnpm --filter @edv4h/russell-worker recheck-sensitive           # 差分を見せるだけ
 *   pnpm --filter @edv4h/russell-worker recheck-sensitive -- --apply  # 実際に付け直す
 *
 * 日記は日付キーで冪等なので、付け直した後に `consolidate --backfill` を流せば
 * その日の日記が正しい内容で書き直される。
 */

import { inspectSensitive } from "@edv4h/russell-core";
import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";

interface Row {
  id: string;
  text: string;
  marks: string[] | null;
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[recheck] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const targets = [
    { table: "notes", text: "content" },
    { table: "books", text: "title || E'\\n' || card" },
    { table: "entities", text: "name || E'\\n' || summary" },
  ];

  try {
    let changed = 0;
    for (const t of targets) {
      const res = await pool.query<Row>(
        `SELECT id::text, ${t.text} AS text, sensitive_categories AS marks
           FROM ${t.table} WHERE agent_id = $1`,
        [agentId],
      );
      for (const row of res.rows) {
        const now = inspectSensitive(row.text).categories;
        const before = row.marks ?? [];
        if (same(before, now)) continue;
        changed++;
        console.log(
          `[recheck] ${t.table}#${row.id}: [${before.join(",") || "なし"}] → [${now.join(",") || "なし"}]`,
        );
        if (apply) {
          await pool.query(`UPDATE ${t.table} SET sensitive_categories = $2 WHERE id = $1`, [
            row.id,
            now,
          ]);
        }
      }
    }

    if (changed === 0) {
      console.log("[recheck] 変更はありません。");
      return;
    }
    if (!apply) {
      console.log(`[recheck] ${changed}件が変わります。適用するには --apply を付けてください。`);
      return;
    }
    // 印の付け替えは記憶の公開範囲を変える操作なので記録する。**件数だけ**（A1-5）
    await appendAuditEvent(pool, {
      agentId,
      configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
      actor: process.env.RUSSELL_OPERATOR ?? "operator",
      action: "memory.sensitive_rechecked",
      payload: { changed },
      trustLabel: "trusted",
    });
    console.log(`[recheck] ${changed}件を付け直し、監査に記録しました。`);
    console.log("[recheck] 日記を直すには consolidate --backfill を流してください。");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
