/**
 * バックアップの CLI（#79）。中身は `backup.ts`（DB 無しで試せるように分けてある）。
 *
 *   pnpm --filter @edv4h/russell-worker backup
 *   pnpm --filter @edv4h/russell-worker backup --dest ~/russell-backups --keep 14
 *
 * 既定の置き場所は `~/.russell/backups`。**リポジトリの中は拒否する**——記憶には
 * 機微情報の印が付いた行があり、`git add .` の射程に入る場所へは置かせない。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDestination, runBackup } from "./backup.js";

/**
 * リポジトリの根。**cwd から求めない。**
 *
 * `pnpm --filter … backup` は cwd をパッケージの中（`apps/worker`）にする。cwd を根だと
 * 思い込むと、「リポジトリの中には置かせない」という関門が `apps/worker` の中だけしか
 * 見なくなり、`docs/` などへ書けてしまう。**自分がどこに置かれているか**から数える。
 *
 * `apps/worker/dist/backup-cli.js` → 3つ上が根。
 */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[backup] DATABASE_URL が未設定です。app と同じ Postgres を指してください。");
    process.exit(1);
  }
  const dest = flag("--dest") ?? process.env.RUSSELL_BACKUP_DIR ?? defaultDestination();
  const keep = Number(flag("--keep") ?? process.env.RUSSELL_BACKUP_KEEP ?? 14);
  if (!Number.isInteger(keep) || keep < 1) {
    console.error(`[backup] --keep は1以上の整数で指定してください（${keep}）`);
    process.exit(1);
  }

  console.log(`[backup] ${dest} へ取ります（${keep}世代を残す）`);
  const result = await runBackup({
    databaseUrl,
    dest,
    keep,
    repoRoot: repoRoot(),
    log: (m) => console.log(m),
  });

  const total = Object.values(result.manifest.rows).reduce((a, b) => a + b, 0);
  console.log(`[backup] 完了: ${result.dir}（${total}行 / 読み直して一致を確認済み）`);
  for (const name of result.removed) console.log(`[backup] 古い分を削除: ${name}`);
  console.log(
    "[backup] **戻せることは、戻して初めて分かります。** 定期的に restore を試してください:",
  );
  console.log(`  pnpm --filter @edv4h/russell-worker restore ${result.dir}`);
}

main().catch((err) => {
  console.error(`[backup] 失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
