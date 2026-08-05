/**
 * DB を使うテストの前段。**本番と同じ形**でスキーマを用意する:
 * アプリ起動時に DDL を流すのではなく、先にマイグレーションを1回流す（§11）。
 *
 * DATABASE_URL が無ければ何もしない（オフラインテストのみ走る）。
 */

import { createMigrationPool, runMigrations } from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS } from "@edv4h/russell-plugin-audit-pg";
import { KILLSWITCH_MIGRATIONS } from "@edv4h/russell-plugin-killswitch-pg";
import { MEMORY_MIGRATIONS } from "@edv4h/russell-plugin-memory-pg";

export async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const pool = createMigrationPool();
  try {
    await runMigrations(pool, [AUDIT_MIGRATIONS, KILLSWITCH_MIGRATIONS, MEMORY_MIGRATIONS], {
      through: "contract",
    });
  } finally {
    await pool.end();
  }
}
