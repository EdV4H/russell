/**
 * 単語帳の重複を1件に畳む（運用コマンド）。
 *
 * 判定するモデルに既存の見出し語を見せるようにして**これから増えるのは止めた**が、
 * 既に分かれてしまった行は残る。実際、同じプロジェクトが4行になっていた。
 *
 *   pnpm --filter @edv4h/russell-worker merge-term -- "残す語" "畳む語" ["畳む語"...]
 *
 * 畳む側の**別名は残す側へ引き継ぐ**（呼び名を失わない）。定義は残す側のものを使う——
 * どちらが正しいかは機械では決められないので、**人が残す側を選ぶ**という形にしてある。
 */

import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";

async function main(): Promise<void> {
  const [keep, ...absorb] = process.argv
    .slice(2)
    .map((a) => a.trim())
    .filter(Boolean);
  if (!process.env.DATABASE_URL) {
    console.error("[merge-term] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  if (!keep || absorb.length === 0) {
    console.error('[merge-term] 使い方: merge-term -- "残す語" "畳む語" ["畳む語"...]');
    process.exit(64);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const target = await client.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM entities
        WHERE agent_id = $1 AND type = 'term' AND lower(name) = lower($2)`,
      [agentId, keep],
    );
    if (target.rowCount === 0) {
      console.error(`[merge-term] 残す語「${keep}」が単語帳にありません。`);
      await client.query("ROLLBACK");
      process.exit(1);
    }

    // 畳む側の name と別名を、残す側の別名に足す（呼び名を失わない）
    const moved = await client.query<{ name: string; aliases: string[] }>(
      `SELECT name, aliases FROM entities
        WHERE agent_id = $1 AND type = 'term' AND lower(name) = ANY($2::text[])`,
      [agentId, absorb.map((a) => a.toLowerCase())],
    );
    if (moved.rowCount === 0) {
      console.log("[merge-term] 畳む対象がありません。");
      await client.query("ROLLBACK");
      return;
    }
    const aliases = [...new Set(moved.rows.flatMap((r) => [r.name, ...r.aliases]))];

    await client.query(
      `UPDATE entities
          SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $3::text[]) EXCEPT SELECT name),
              updated_at = now()
        WHERE agent_id = $1 AND type = 'term' AND lower(name) = lower($2)`,
      [agentId, keep, aliases],
    );
    const deleted = await client.query(
      `DELETE FROM entities
        WHERE agent_id = $1 AND type = 'term' AND lower(name) = ANY($2::text[])`,
      [agentId, absorb.map((a) => a.toLowerCase())],
    );
    await client.query("COMMIT");

    console.log(
      `[merge-term] ${target.rows[0]?.name} に ${deleted.rowCount}件を畳みました（別名: ${aliases.join(", ")}）`,
    );
    // 記憶の構造を変える操作なので記録する。**語そのものは残す**（本文ではないので A1-5 に触れない）
    await appendAuditEvent(pool, {
      agentId,
      configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
      actor: process.env.RUSSELL_OPERATOR ?? "operator",
      action: "memory.terms_merged",
      payload: { keep, absorbed: absorb, deleted: deleted.rowCount ?? 0 },
      trustLabel: "trusted",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
