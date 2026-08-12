/**
 * 監査ログの退避（#26）。
 *
 * `event_log` は**唯一増え続けるテーブル**で、しかも削除経路を自分で塞いである。
 * 埋まると次の連鎖が起きる:
 *
 *   event_log に書けない → 監査 degraded → Policy Gate が read 以外を deny（fail-closed）
 *   → 応答も記憶書き込みも止まる
 *
 * 方針は「**削除しない**」（privacy-and-memory-policy）なので、**消すのではなく外へ出す**。
 * 先に JSONL へ書き出し、書き出せたことを確かめてから、ライブのテーブルから外す。
 *
 *   pnpm archive-events                              # いまの状況を見るだけ
 *   pnpm archive-events --before 2026-06-01 --out a.jsonl          # 書き出しの下見
 *   pnpm archive-events --before 2026-06-01 --out a.jsonl --apply  # 書き出して外す
 *
 * **自動では走らせない。** 監査を減らす操作は、いつ誰がやったかが分かる形で人がやる。
 */

import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[archive] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  const before = flag("--before");
  const out = flag("--out");
  const apply = process.argv.includes("--apply");
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // まず現状を出す。**埋まってから気づくのが最悪**なので、いつでも見られるようにしておく
    const overview = await pool.query<{ n: string; oldest: Date | null; size: string }>(
      `SELECT count(*)::text AS n, min(ts) AS oldest,
              pg_size_pretty(pg_total_relation_size('event_log')) AS size
         FROM event_log`,
    );
    const o = overview.rows[0];
    console.log(
      `[archive] event_log: ${o?.n} 行 / ${o?.size} / 最古 ${o?.oldest?.toISOString() ?? "-"}`,
    );

    if (!before) {
      console.log(
        "[archive] 退避するには --before <YYYY-MM-DD> --out <ファイル> を指定してください。",
      );
      return;
    }
    const target = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event_log WHERE ts < $1::date",
      [before],
    );
    const count = Number(target.rows[0]?.n ?? 0);
    console.log(`[archive] ${before} より前: ${count} 行`);
    if (count === 0) return;
    if (!out) {
      console.log("[archive] --out <ファイル> が要ります（**書き出さずに外すことはしません**）。");
      return;
    }

    // 書き出し。**先に外へ出す**——出せなかったのに外した、を作らない
    const file = createWriteStream(out, { flags: "w" });
    const rows = await pool.query("SELECT * FROM event_log WHERE ts < $1::date ORDER BY id ASC", [
      before,
    ]);
    for (const row of rows.rows) file.write(`${JSON.stringify(row)}\n`);
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error) => (err ? reject(err) : resolve()));
    });
    const written = (await stat(out)).size;
    console.log(`[archive] ${rows.rowCount} 行を ${out} に書き出しました（${written} バイト）`);

    if (!apply) {
      console.log("[archive] --apply を付けると、ライブのテーブルから外します。");
      return;
    }

    // 外す。**セッション変数が立っているときだけ** DELETE が通る（誤操作では消えない）
    const client = await pool.connect();
    let deleted = 0;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL russell.archive = 'on'");
      const res = await client.query("DELETE FROM event_log WHERE ts < $1::date", [before]);
      deleted = res.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // 退避したこと自体を監査に残す。**何行をどこへ出したか**が追えないと、後から確認できない
    await appendAuditEvent(pool, {
      agentId,
      configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
      actor: process.env.RUSSELL_OPERATOR ?? "operator",
      action: "event_log.archived",
      payload: { before, rows: deleted, file: out, bytes: written },
      trustLabel: "trusted",
    });
    console.log(`[archive] ${deleted} 行を外しました。記録は ${out} にあります。`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
