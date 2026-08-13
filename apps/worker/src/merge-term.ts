/**
 * 索引カード（単語帳・個人カルテ）の重複を1件に畳む（運用コマンド）。
 *
 * 判定するモデルに既存の見出しを見せるようにして**これから増えるのは止めた**が、
 * 既に分かれてしまった行は残る。実際、同じプロジェクトが4行になり、
 * 同じ人が別の呼び名で二重にカルテへ載った。
 *
 *   pnpm --filter @edv4h/russell-worker merge-term -- "残す語" "畳む語" ["畳む語"...]
 *   pnpm --filter @edv4h/russell-worker merge-term -- --person "残す人" "畳む人" [...]
 *
 * 畳む側の**別名は残す側へ引き継ぐ**（呼び名を失わない）。中身は残す側のものを使う——
 * どちらが正しいかは機械では決められないので、**人が残す側を選ぶ**という形にしてある。
 */

import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";

async function main(): Promise<void> {
  // `--` そのものが引数として渡ってくる（pnpm 経由）。残すと「畳む語」に混ざる
  const args = process.argv
    .slice(2)
    .map((a) => a.trim())
    .filter((a) => a && a !== "--");
  // 既定は単語帳。人のカルテも同じ形なので、型だけ切り替える
  const type = args[0] === "--person" ? "person" : "term";
  const label = type === "person" ? "カルテ" : "単語帳";
  const [keep, ...absorb] = args[0] === "--person" ? args.slice(1) : args;
  if (!process.env.DATABASE_URL) {
    console.error("[merge-term] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  if (!keep || absorb.length === 0) {
    console.error(
      '[merge-term] 使い方: merge-term -- [--person] "残す見出し" "畳む見出し" ["畳む見出し"...]',
    );
    process.exit(64);
  }
  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const target = await client.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM entities
        WHERE agent_id = $1 AND type = $3 AND lower(name) = lower($2)`,
      [agentId, keep, type],
    );
    if (target.rowCount === 0) {
      console.error(`[merge-term] 残す見出し「${keep}」が${label}にありません。`);
      await client.query("ROLLBACK");
      process.exit(1);
    }

    // 畳む側の name と別名を、残す側の別名に足す（呼び名を失わない）。
    // **紐付け（external_ids）も引き継ぐ。** Slack 側からは取れない情報なので、
    // 畳む側にしか無い id を落とすと二度と復元できない（ADR 0008）
    const moved = await client.query<{ name: string; aliases: string[]; external_ids: string[] }>(
      `SELECT name, aliases, external_ids FROM entities
        WHERE agent_id = $1 AND type = $3 AND lower(name) = ANY($2::text[])`,
      [agentId, absorb.map((a) => a.toLowerCase()), type],
    );
    if (moved.rowCount === 0) {
      console.log("[merge-term] 畳む対象がありません。");
      await client.query("ROLLBACK");
      return;
    }
    const aliases = [...new Set(moved.rows.flatMap((r) => [r.name, ...r.aliases]))];
    const externalIds = [...new Set(moved.rows.flatMap((r) => r.external_ids))];

    await client.query(
      `UPDATE entities
          SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $3::text[]) EXCEPT SELECT name),
              external_ids = ARRAY(SELECT DISTINCT unnest(external_ids || $5::text[])),
              updated_at = now()
        WHERE agent_id = $1 AND type = $4 AND lower(name) = lower($2)`,
      [agentId, keep, aliases, type, externalIds],
    );
    const deleted = await client.query(
      `DELETE FROM entities
        WHERE agent_id = $1 AND type = $3 AND lower(name) = ANY($2::text[])`,
      [agentId, absorb.map((a) => a.toLowerCase()), type],
    );
    await client.query("COMMIT");

    console.log(
      `[merge-term] ${target.rows[0]?.name} に ${deleted.rowCount}件を畳みました` +
        `（別名: ${aliases.join(", ")}${externalIds.length > 0 ? ` / 紐付け: ${externalIds.join(", ")}` : ""}）`,
    );
    // 記憶の構造を変える操作なので記録する。**語そのものは残す**（本文ではないので A1-5 に触れない）
    await appendAuditEvent(pool, {
      agentId,
      configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
      actor: process.env.RUSSELL_OPERATOR ?? "operator",
      action: "memory.terms_merged",
      payload: {
        type,
        keep,
        absorbed: absorb,
        deleted: deleted.rowCount ?? 0,
        externalIds: externalIds.length,
      },
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
