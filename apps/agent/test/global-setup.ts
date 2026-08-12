/**
 * DB を使うテストの前段。
 *
 * 1. **テスト専用 DB を作り直す。** 開発用 DB とは分ける——共有していると、テストが作った
 *    個体で記憶が埋もれる（ビューアを入れて発覚した）。毎回作り直すので、前回の残骸も消える。
 * 2. **本番と同じ形**でスキーマを用意する: アプリ起動時に DDL を流すのではなく、
 *    先にマイグレーションを1回流す（§11）。
 *
 * DATABASE_URL が無ければ何もしない（オフラインテストのみ走る）。
 * 終わっても DB は消さない——落ちたときに中を見られる方がよいので。次の実行で作り直す。
 */

import { createMigrationPool, runMigrations } from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS } from "@edv4h/russell-plugin-audit-pg";
import { KILLSWITCH_MIGRATIONS } from "@edv4h/russell-plugin-killswitch-pg";
import { MEMORY_MIGRATIONS } from "@edv4h/russell-plugin-memory-pg";
import { ROUTINES_MIGRATIONS } from "@edv4h/russell-plugin-routines-pg";
import { SETTINGS_MIGRATIONS } from "@edv4h/russell-plugin-settings-pg";
import { testDatabaseName, toTestDatabaseUrl } from "./test-db.js";

export async function setup(): Promise<void> {
  // globalSetup が見るのは開発用 DB（vitest.config.ts が test 側の env だけを差し替えるため）。
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) return;

  const name = testDatabaseName(devUrl);
  // pg を直接持ち込まない（ルートから解決できない）。ランナーのプール生成で足りる。
  const admin = createMigrationPool(devUrl);
  try {
    // FORCE で接続ごと切る。前回の実行が残したプールが繋ぎっぱなしでも作り直せる。
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const pool = createMigrationPool(toTestDatabaseUrl(devUrl));
  try {
    await runMigrations(
      pool,
      [
        AUDIT_MIGRATIONS,
        KILLSWITCH_MIGRATIONS,
        MEMORY_MIGRATIONS,
        ROUTINES_MIGRATIONS,
        SETTINGS_MIGRATIONS,
      ],
      { through: "contract" },
    );
  } finally {
    await pool.end();
  }
}
