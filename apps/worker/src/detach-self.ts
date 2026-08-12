/**
 * 個人カルテから**個体自身**を外す（運用コマンド）。
 *
 * 個体の名前が他人のカルテに呼び名として入り、紐付けの規則（名前が一致する人を発言から拾う）が
 * **自分の Slack id まで結びつけていた**。個体が自分を「一緒に働く人」として持つと、
 * 想起にも退職者対応（id で指定する）にも響く。
 *
 * これから増えるのはコア側で止めたが、**既に入っている行は残る**ので、ここで掃除する。
 *
 *   pnpm --filter @edv4h/russell-worker detach-self -- "Bob" [slack:U0BNJ3R4BFD ...]
 *   pnpm --filter @edv4h/russell-worker detach-self -- "Bob" slack:U0… --apply
 *
 * **既定は見るだけ。** 書き換えるのは `--apply` を付けたときだけにしてある——
 * 記憶を消す操作は取り返しがつかないので、まず何が起きるかを見せる。
 */

import { appendAuditEvent } from "@edv4h/russell-plugin-audit-pg";
import pg from "pg";

interface Row {
  name: string;
  aliases: string[];
  external_ids: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(Boolean);
  const apply = args.includes("--apply");
  const [selfName, ...ids] = args.filter((a) => a !== "--apply");

  if (!process.env.DATABASE_URL) {
    console.error("[detach-self] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  if (!selfName) {
    console.error('[detach-self] 使い方: detach-self -- "個体の名前" [外部id ...] [--apply]');
    process.exit(64);
  }

  const agentId = process.env.RUSSELL_AGENT_ID ?? "bob";
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const self = selfName.trim().toLowerCase();

  try {
    const res = await pool.query<Row>(
      "SELECT name, aliases, external_ids FROM entities WHERE agent_id = $1 AND type = 'person'",
      [agentId],
    );

    // 個体自身のカルテ（見出しが自分）。**丸ごと消す**——これは人の記録ではない
    const own = res.rows.filter((r) => r.name.trim().toLowerCase() === self);
    // 他人のカルテに混ざった自分（呼び名 / 外部 id）
    const dirty = res.rows.filter((r) => {
      if (r.name.trim().toLowerCase() === self) return false;
      const alias = r.aliases.some((a) => a.trim().toLowerCase() === self);
      const id = r.external_ids.some((e) => ids.includes(e));
      return alias || id;
    });

    for (const r of own) console.log(`  消す（自分のカルテ）: ${r.name}`);
    for (const r of dirty) {
      const alias = r.aliases.filter((a) => a.trim().toLowerCase() === self);
      const id = r.external_ids.filter((e) => ids.includes(e));
      console.log(`  外す: ${r.name} から ${[...alias, ...id].join(", ")}`);
    }
    if (own.length === 0 && dirty.length === 0) {
      console.log("[detach-self] 混ざっているものはありません。");
      return;
    }
    if (!apply) {
      console.log(
        `[detach-self] 見るだけで終わりました（自分のカルテ ${own.length}件 / 混入 ${dirty.length}件）。実行するには --apply を付けてください。`,
      );
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await client.query(
        "DELETE FROM entities WHERE agent_id = $1 AND type = 'person' AND lower(name) = $2",
        [agentId, self],
      );
      // 呼び名と紐付けから自分を外す。**中身（summary）には触らない**——
      // そこに何が書かれているかは人が読んで決めることで、機械が消してよいものではない
      const cleaned = await client.query(
        `UPDATE entities
            SET aliases = ARRAY(SELECT a FROM unnest(aliases) a WHERE lower(a) <> $2),
                external_ids = ARRAY(SELECT e FROM unnest(external_ids) e WHERE e <> ALL($3::text[])),
                updated_at = now()
          WHERE agent_id = $1 AND type = 'person'
            AND (EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = $2)
                 OR external_ids && $3::text[])`,
        [agentId, self, ids],
      );
      await client.query("COMMIT");
      console.log(
        `[detach-self] 自分のカルテ ${deleted.rowCount ?? 0}件を消し、${cleaned.rowCount ?? 0}件から自分を外しました。`,
      );

      // 記憶の構造を変える操作なので記録する（名前は残す。本文ではないので A1-5 に触れない）
      await appendAuditEvent(pool, {
        agentId,
        configVersion: process.env.RUSSELL_CONFIG_VERSION ?? "v0",
        actor: process.env.RUSSELL_OPERATOR ?? "operator",
        action: "memory.self_detached",
        payload: {
          selfName,
          externalIds: ids,
          deleted: deleted.rowCount ?? 0,
          cleaned: cleaned.rowCount ?? 0,
        },
        trustLabel: "trusted",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[detach-self] 失敗:", err);
  process.exit(1);
});
