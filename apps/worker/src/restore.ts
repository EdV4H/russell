/**
 * バックアップから戻す（#79）。
 *
 * > [!IMPORTANT]
 * > **既定では本番の DB へ戻さない。** 戻し先は `<db>_restore` という別の DB で、
 * > そこへ入れてから目録と突き合わせる。「取れているが戻せない」を見つけるのが目的なので、
 * > 確かめるたびに本物を壊す危険があっては、確かめなくなる。
 * >
 * > 本物へ戻すには `--into-live` を明示する（事故で通り抜けない形にしてある）。
 *
 * > [!IMPORTANT]
 * > **空の DB にしか入れない。** `event_log` は追記専用で、UPDATE / DELETE / TRUNCATE が
 * > トリガーで拒否される（§3.1）。中身のある DB へ重ねると、消せないまま二重になる。
 *
 * 手順は「スキーマは migrate で作り、データだけ流し込む」。pg_dump 由来のスキーマを
 * 持ち歩かないので、**戻した先は必ずいまのコードが期待する形**になる。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { BackupManifest, ColumnType } from "./backup.js";

/** 戻し先の DB 名。**本番とは別**にする（`russell` → `russell_restore`）。 */
export function toRestoreDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  if (name.endsWith("_restore")) return url.toString();
  url.pathname = `/${name}_restore`;
  return url.toString();
}

/** `postgres` へ繋ぐための URL（DB を作る / 消すときに要る）。 */
export function toAdminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseNameOf(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "");
}

/**
 * マイグレーションの台帳。**これは記憶ではなく、スキーマの記録である。**
 *
 * バックアップには入れる（そのデータがどの形のスキーマに属するかが分かる）が、**戻さない**。
 * 戻し先のスキーマは `migrate` が作るので、台帳もそちらが書く——上から流し込むと二重になる。
 *
 * > [!IMPORTANT]
 * > ここを「記憶」と同じに扱っていたせいで、**手順どおりの復元が一度も成功しなかった**。
 * > migrate した直後の DB は台帳に行があるので、「空ではない」と判定されて必ず断られていた。
 * > 往復のテストを実際に流すまで気づけなかった（単体のテストは全部通っていた）。
 *
 * 代わりに**互換性の確認**に使う。バックアップが持っているマイグレーションを戻し先が
 * 持っていなければ、列が足りない可能性があるので戻さない。
 */
export const SCHEMA_LEDGER = "schema_migrations";

export interface BackupContents {
  manifest: BackupManifest;
  /** 戻す対象のテーブル（**台帳は含まない**）。 */
  tables: string[];
  /** バックアップに入っていた台帳の行。互換性の確認に使う。 */
  ledger: string[];
}

/** 台帳の1行を `namespace/id` に直す。並び順に依らず突き合わせるため。 */
export function ledgerKeys(rows: unknown[][], columns: ColumnType[]): string[] {
  const ns = columns.findIndex((c) => c.name === "namespace");
  const id = columns.findIndex((c) => c.name === "id");
  if (ns < 0 || id < 0) return [];
  return rows.map((r) => `${String(r[ns])}/${String(r[id])}`).sort();
}

/**
 * 戻し先のスキーマが、このデータを受け止められるか。
 *
 * - **バックアップにあって戻し先に無い** → 断る（列が足りず、黙って欠けるより落ちる方がよい）
 * - **戻し先にあってバックアップに無い** → 通す（スキーマが先に進んだだけ。合わなければ INSERT が落ちる）
 */
export function schemaGap(
  backup: string[],
  target: string[],
): { missing: string[]; ahead: string[] } {
  const t = new Set(target);
  const b = new Set(backup);
  return {
    missing: backup.filter((k) => !t.has(k)),
    ahead: target.filter((k) => !b.has(k)),
  };
}

/** 置き場所を読む。**目録が無ければ受け付けない**（どこまで入っているか言えないため）。 */
export function readBackup(dir: string): BackupContents {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    throw new Error(`restore: 目録が読めません（${join(dir, "manifest.json")}）`);
  }
  const found = readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.replace(/\.jsonl$/, ""))
    .sort();
  // 目録にあるのにファイルが無い＝**取り切れていないバックアップ**。戻す前に気づく
  const missing = Object.keys(manifest.rows).filter((t) => !found.includes(t));
  if (missing.length > 0) {
    throw new Error(`restore: 目録にあるファイルがありません: ${missing.join(", ")}`);
  }

  let ledger: string[] = [];
  if (found.includes(SCHEMA_LEDGER)) {
    const columns = JSON.parse(
      readFileSync(join(dir, `${SCHEMA_LEDGER}.columns.json`), "utf8"),
    ) as ColumnType[];
    const rows = readFileSync(join(dir, `${SCHEMA_LEDGER}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown[]);
    ledger = ledgerKeys(rows, columns);
  }
  // 台帳は**戻す対象ではない**（スキーマは migrate が作る）
  return { manifest, tables: found.filter((t) => t !== SCHEMA_LEDGER), ledger };
}

/**
 * 目録と実際の行数を突き合わせる。**合わないものだけ**返す（空なら一致）。
 *
 * 台帳は数えない——戻していないので、合わなくて当たり前である。
 */
export function countMismatches(
  manifest: BackupManifest,
  actual: Record<string, number>,
): string[] {
  const bad: string[] = [];
  for (const [table, expected] of Object.entries(manifest.rows)) {
    if (table === SCHEMA_LEDGER) continue;
    const got = actual[table] ?? 0;
    if (got !== expected) bad.push(`${table}（期待 ${expected} / 実際 ${got}）`);
  }
  return bad;
}

/** 1行分の INSERT。**列の型で明示的にキャストする**——jsonb と配列を取り違えないため。 */
export function insertStatement(table: string, columns: ColumnType[]): string {
  const names = columns.map((c) => `"${c.name}"`).join(", ");
  const values = columns.map((c, i) => `$${i + 1}::${c.dataType}`).join(", ");
  return `INSERT INTO "${table}" (${names}) VALUES (${values})`;
}

/** 連番を今の最大値へ合わせる。**やらないと次の登録が衝突する**（戻した直後に壊れる）。 */
export async function resetSequences(client: pg.ClientBase, table: string): Promise<void> {
  const res = await client.query<{ column_name: string; seq: string | null }>(
    `SELECT column_name, pg_get_serial_sequence($1, column_name) AS seq
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $2`,
    [`public.${table}`, table],
  );
  for (const row of res.rows) {
    if (!row.seq) continue;
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX("${row.column_name}") FROM "${table}"), 0) + 1, false)`,
      [row.seq],
    );
  }
}

export interface RestoreOptions {
  dir: string;
  /** 戻し先。**呼び出し側が決める**（既定を安全側にするのは CLI の仕事）。 */
  targetUrl: string;
  log?: (message: string) => void;
}

export interface RestoreResult {
  loaded: Record<string, number>;
  mismatches: string[];
  /** 戻し先の方が新しかったマイグレーション。**黙って進めない**ので呼び出し側へ返す。 */
  schemaAhead: string[];
}

/**
 * 流し込む。**先に空であることを確かめる。**
 *
 * スキーマは呼び出し側が migrate で用意しておく。ここはデータだけを見る。
 */
export async function loadBackup(options: RestoreOptions): Promise<RestoreResult> {
  const log = options.log ?? (() => {});
  const { manifest, tables, ledger } = readBackup(options.dir);

  const client = new pg.Client({ connectionString: options.targetUrl });
  await client.connect();
  try {
    // **戻し先のスキーマが受け止められるか、先に見る。**
    // 足りないまま流すと、列が無いだけの失敗が「バックアップが壊れている」に見える
    const applied = await client.query<{ namespace: string; id: string }>(
      `SELECT namespace, id FROM ${SCHEMA_LEDGER}`,
    );
    const gap = schemaGap(ledger, applied.rows.map((r) => `${r.namespace}/${r.id}`).sort());
    if (gap.missing.length > 0) {
      throw new Error(
        `restore: 戻し先のスキーマが古いです（未適用: ${gap.missing.join(", ")}）。先に migrate してください`,
      );
    }

    // **空でなければ入れない。** event_log は消せないので、重ねると取り返しがつかない
    const dirty: string[] = [];
    for (const table of tables) {
      const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
      if (Number(res.rows[0]?.n ?? 0) > 0) dirty.push(table);
    }
    if (dirty.length > 0) {
      throw new Error(
        `restore: 戻し先が空ではありません（${dirty.join(", ")}）。空の DB を用意してください`,
      );
    }

    await client.query("BEGIN");
    const loaded: Record<string, number> = {};
    for (const table of tables) {
      const columns = JSON.parse(
        readFileSync(join(options.dir, `${table}.columns.json`), "utf8"),
      ) as ColumnType[];
      const sql = insertStatement(table, columns);
      const lines = readFileSync(join(options.dir, `${table}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      for (const line of lines) {
        await client.query(sql, JSON.parse(line) as unknown[]);
      }
      loaded[table] = lines.length;
      log(`  ${table}: ${lines.length}行`);
    }
    await client.query("COMMIT");

    for (const table of tables) await resetSequences(client, table);

    // **入れた数ではなく、入っている数を数える。** 入れたつもりを成功と呼ばない
    const actual: Record<string, number> = {};
    for (const table of tables) {
      const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
      actual[table] = Number(res.rows[0]?.n ?? 0);
    }
    return { loaded, mismatches: countMismatches(manifest, actual), schemaAhead: gap.ahead };
  } finally {
    await client.end().catch(() => {});
  }
}

/** 戻し先の DB を作り直す（**別 DB のときだけ**呼ぶ。本番へは使わない）。 */
export async function recreateDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end().catch(() => {});
  }
}
