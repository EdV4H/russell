/**
 * 復元の CLI（#79）。**戻せることは、戻して初めて分かる。**
 *
 *   pnpm --filter @edv4h/russell-worker restore ~/.russell/backups/russell-20260824-170000
 *   pnpm --filter @edv4h/russell-worker restore <dir> --into-live   # 本物へ戻す（事故のとき）
 *
 * 既定の戻し先は `<db>_restore`。**確かめるたびに本物を壊す危険があると、確かめなくなる。**
 * 本物へ戻すのは事故のときだけなので、そちらを明示にしてある。
 */

import { type MigrationSet, createMigrationPool, runMigrations } from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS } from "@edv4h/russell-plugin-audit-pg";
import { KILLSWITCH_MIGRATIONS } from "@edv4h/russell-plugin-killswitch-pg";
import { MEMORY_MIGRATIONS } from "@edv4h/russell-plugin-memory-pg";
import { ROUTINES_MIGRATIONS } from "@edv4h/russell-plugin-routines-pg";
import { SETTINGS_MIGRATIONS } from "@edv4h/russell-plugin-settings-pg";
import {
  databaseNameOf,
  loadBackup,
  recreateDatabase,
  toAdminUrl,
  toRestoreDatabaseUrl,
} from "./restore.js";

/** migrate CLI と同じ構成。ずれると「戻した先だけ形が違う」が起きる。 */
const SETS: MigrationSet[] = [
  AUDIT_MIGRATIONS,
  KILLSWITCH_MIGRATIONS,
  MEMORY_MIGRATIONS,
  ROUTINES_MIGRATIONS,
  SETTINGS_MIGRATIONS,
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[restore] DATABASE_URL が未設定です。");
    process.exit(1);
  }
  const dir = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!dir) {
    console.error(
      "[restore] バックアップの置き場所を指定してください（backup が出したディレクトリ）",
    );
    process.exit(1);
  }
  const intoLive = process.argv.includes("--into-live");
  const targetUrl = intoLive ? databaseUrl : toRestoreDatabaseUrl(databaseUrl);
  const targetName = databaseNameOf(targetUrl);

  if (intoLive) {
    // **本物へ戻すのは事故のとき。** 通り抜けないよう、ここで止めて目で確かめさせる
    console.log(`[restore] **本番の DB へ戻します**: ${targetName}`);
    console.log("[restore] 空でなければ拒否します。続けるには 5 秒待ちます…");
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    console.log(`[restore] 確認用の DB を作り直します: ${targetName}`);
    await recreateDatabase(toAdminUrl(databaseUrl), targetName);
    process.env.DATABASE_URL = targetUrl; // createMigrationPool が読む
    const pool = createMigrationPool();
    try {
      const result = await runMigrations(pool, SETS, { through: "contract" });
      console.log(`[restore] スキーマを作りました（${result.applied.length}件）`);
    } finally {
      await pool.end().catch(() => {});
    }
  }

  const result = await loadBackup({ dir, targetUrl, log: (m) => console.log(m) });
  const total = Object.values(result.loaded).reduce((a, b) => a + b, 0);

  if (result.schemaAhead.length > 0) {
    // 止めはしない（追加だけのマイグレーションなら問題なく入る）が、**黙らない**。
    // 「戻したのに列が空」の原因がここにあることがある
    console.warn(
      `[restore] 戻し先の方が新しいスキーマです（${result.schemaAhead.join(", ")}）。入りましたが、古いデータであることを踏まえてください`,
    );
  }

  if (result.mismatches.length > 0) {
    // **入れたつもりを成功と呼ばない。** ここが黙ると、バックアップを信じたまま失う
    console.error(`[restore] 目録と一致しません: ${result.mismatches.join(", ")}`);
    process.exit(1);
  }
  console.log(`[restore] 完了: ${targetName} に ${total}行（目録と一致）`);
  if (!intoLive) {
    console.log("[restore] 中身を見るには、この DB を指してビューアを起動してください");
  }
}

main().catch((err) => {
  console.error(`[restore] 失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
