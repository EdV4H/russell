/**
 * 人の記憶を消す（退職者対応・削除依頼）。
 *
 * **記憶で唯一の物理削除**である。本棚の「忘れて」は書庫へ下げるだけで消さないが
 * （privacy-and-memory-policy §3 の L1）、**人物データだけは同ポリシーが明示的に
 * 例外にしている**（§2「退職から N 日以内に本人発言由来の記憶を削除または匿名化」）。
 *
 * 個体には使わせない。**運用者が手で叩く経路**として worker に置く——
 * 「消して」と言われた個体が自分で消せる状態にはしない（承認者が実行する, §2）。
 *
 *   pnpm --filter @edv4h/russell-worker forget-person -- "丸山"
 */

import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  if (!process.env.DATABASE_URL) {
    console.error("[forget-person] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  if (!name) {
    console.error('[forget-person] 消す人の名前を渡してください: forget-person -- "名前"');
    process.exit(64);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 何を消すのかを**先に見せる**。不可逆なので、名前の取り違えに気づける最後の機会になる
    const target = await pool.query<{ name: string; aliases: string[] }>(
      `SELECT name, aliases FROM entities
        WHERE agent_id = $1 AND type = 'person'
          AND (lower(name) = lower($2) OR $2 = ANY(aliases))`,
      [agentId, name],
    );
    if (target.rowCount === 0) {
      console.log(`[forget-person] 「${name}」の記憶はありません。`);
      return;
    }
    for (const row of target.rows) {
      console.log(`[forget-person] 削除: ${row.name}（別名: ${row.aliases.join(", ") || "なし"}）`);
    }

    const res = await pool.query(
      `DELETE FROM entities
        WHERE agent_id = $1 AND type = 'person'
          AND (lower(name) = lower($2) OR $2 = ANY(aliases))`,
      [agentId, name],
    );
    // 実行は必ず記録する（§2「実行は config_version と event_log に記録」）。
    // **名前は残す**——誰の削除依頼に応じたかを追えないと、対応した証明ができない。
    // ここは本文（カルテの中身）ではないので A1-5 に触れない。
    await appendAuditEvent(pool, {
      agentId,
      configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
      actor: process.env.RUSSELL_OPERATOR ?? "operator",
      action: "memory.person.deleted",
      payload: { name, deleted: res.rowCount ?? 0 },
      trustLabel: "trusted",
    });
    console.log(`[forget-person] ${res.rowCount ?? 0}件を削除し、監査に記録しました。`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
