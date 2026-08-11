/**
 * マイグレーション CLI（§11）。スキーマを作るのは**この経路だけ**で、アプリの起動は DDL を流さない。
 *
 *   pnpm migrate            # expand → backfill まで適用（contract は流さない）
 *   pnpm migrate up --contract  # 旧構造の撤去まで含めて適用（新コードが行き渡った後に実行）
 *   pnpm migrate status     # 適用済み / 未適用 / 改変 を一覧
 *
 * 3段デプロイの手順（expand→backfill→contract）:
 *   1. `pnpm migrate`（expand・backfill）— 旧コードが動いたまま新構造が入る
 *   2. 新コードをデプロイ — 全インスタンスが入れ替わるのを待つ
 *   3. `pnpm migrate up --contract` — 旧構造を落とす
 *
 * 名前空間はプラグインが持つ。ここは「この構成で使うテーブル群」を集める組み立てホスト側の責務
 * （main.ts がプラグイン配列を組むのと同じ役割）。
 */

import {
  type MigrationSet,
  createMigrationPool,
  migrationStatus,
  runMigrations,
} from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS } from "@edv4h/russell-plugin-audit-pg";
import { KILLSWITCH_MIGRATIONS } from "@edv4h/russell-plugin-killswitch-pg";
import { MEMORY_MIGRATIONS } from "@edv4h/russell-plugin-memory-pg";
import { SETTINGS_MIGRATIONS } from "@edv4h/russell-plugin-settings-pg";

/** スポンジプリセットが使うテーブル群。プラグインを増やしたらここに足す。 */
const SETS: MigrationSet[] = [
  AUDIT_MIGRATIONS,
  KILLSWITCH_MIGRATIONS,
  MEMORY_MIGRATIONS,
  SETTINGS_MIGRATIONS,
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith("-")) ?? "up";
  const includeContract = argv.includes("--contract") || argv.includes("--through=contract");

  const pool = createMigrationPool();
  try {
    if (command === "status") {
      const status = await migrationStatus(pool, SETS);
      console.log(`ledger: ${status.ledgerExists ? "あり" : "なし（未 migrate）"}`);
      for (const a of status.applied) {
        console.log(`  applied  ${a.namespace}/${a.id} (${a.phase}) ${a.appliedAt.toISOString()}`);
      }
      for (const p of status.pending) {
        console.log(`  pending  ${p.namespace}/${p.id} (${p.phase})`);
      }
      for (const d of status.drifted) {
        console.log(`  DRIFT    ${d.namespace}/${d.id} — 適用済みの SQL が変更されています`);
      }
      if (status.drifted.length > 0) process.exitCode = 1;
      return;
    }

    if (command !== "up") {
      console.error("使い方: pnpm migrate [up|status] [--contract]");
      process.exitCode = 2;
      return;
    }

    const result = await runMigrations(pool, SETS, {
      through: includeContract ? "contract" : "backfill",
      log: (m) => console.log(m),
    });
    if (result.applied.length === 0) console.log("[migrate] 適用するものはありません");
    for (const d of result.deferred) {
      console.log(
        `[migrate] 見送り ${d.namespace}/${d.id} (${d.phase}) — 新コードの配布後に \`--contract\` で適用してください`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
