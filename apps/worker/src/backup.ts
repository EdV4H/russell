/**
 * 記憶のバックアップ（#79）。
 *
 * **このプロダクトの価値は記憶そのものである。** 会話の文脈は Slack から取り直せるが
 * （ADR 0001）、メモ帳・本棚・単語帳・個人カルテ・日記・監査ログ・設定・予定は
 * Russell の DB にしかない。いまそれはローカルのボリューム1つに載っている。
 *
 * > [!IMPORTANT]
 * > **忘れやすいのは壊れることではなく、テーブルを1つ取り忘れることである。**
 * > だから対象を書き並べない——**DB にあるテーブルを全部**取る。プラグインが増えて
 * > テーブルが増えても、ここを直さなくてよい（直し忘れが起きない）。
 *
 * > [!IMPORTANT]
 * > **取れたことを確かめてから成功と言う。** 書いたファイルを読み直し、行数が
 * > 数えた通りかを見る。取れているつもりで戻せない、が一番多い失敗である。
 *
 * pg_dump は使っていない。手元に無いことがあり（実際この環境には無い）、
 * バージョンを合わせる話が付いて回る。記憶は千行の桁なので、素直に読み出す方が確実。
 *
 *   pnpm --filter @edv4h/russell-worker backup
 *   pnpm --filter @edv4h/russell-worker backup --dest ~/russell-backups --keep 14
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

/** 1回分のバックアップに添える目録。**戻すときに突き合わせる**。 */
export interface BackupManifest {
  /** いつ取ったか（ISO8601）。 */
  takenAt: string;
  /** どの DB から取ったか。**資格情報は入れない**（バックアップ自体が読まれうる）。 */
  database: string;
  /** テーブルごとの行数。復元後にこれと一致しなければ、戻し切れていない。 */
  rows: Record<string, number>;
}

/** バックアップ1回分の置き場所の名前。**並べたときに時系列で読める**形にする。 */
export function backupName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `russell-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * どれを消すか。**新しい方から `keep` 個を残す。**
 *
 * 名前が時系列に並ぶ形なので、名前で並べ替えれば済む（ファイルの時刻を見ない——
 * コピーや復元で時刻は変わるが、いつ取ったかは変わらない）。
 */
export function expiredBackups(names: string[], keep: number): string[] {
  const ours = names.filter((n) => /^russell-\d{8}-\d{6}$/.test(n)).sort();
  if (keep <= 0) return [];
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/**
 * 置き場所として使ってよいか。
 *
 * **リポジトリの中には置かせない。** 記憶には機微情報の印が付いた行がある（ADR 0007）。
 * 置いた瞬間に `git add .` の射程へ入る場所は、置き場所として不適切である。
 */
export function assertSafeDestination(dest: string, repoRoot: string): void {
  const d = resolve(dest);
  const r = resolve(repoRoot);
  if (d === r || d.startsWith(`${r}/`)) {
    throw new Error(
      `backup: リポジトリの中には置けません（${d}）。記憶には機微情報の印が付いた行があります。--dest で外を指してください`,
    );
  }
}

/** 既定の置き場所。リポジトリの外で、持ち主にしか読めないところ。 */
export function defaultDestination(): string {
  return join(homedir(), ".russell", "backups");
}

/** 資格情報を落とした表示用の DB 名。目録に残すのはこちら。 */
export function safeDatabaseLabel(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.host}${url.pathname}`;
}

/** どの列がどの型か。**jsonb は文字列に直して書く**（戻すときに配列と取り違えないため）。 */
export interface ColumnType {
  name: string;
  /** **そのままキャストに書ける形**（`text[]` / `vector` / `timestamp with time zone` など）。 */
  dataType: string;
}

/**
 * `information_schema` の言い方を、**SQL に書ける型名**へ直す。
 *
 * > [!IMPORTANT]
 * > `data_type` は配列を `ARRAY` としか言わない。そのまま `$1::ARRAY` と書くと構文エラーになる
 * > ——実際に往復のテストで落ちた。要素の型は `udt_name` にあり、`text[]` なら `_text` という
 * > 形で入っているので、頭の `_` を外して `[]` を付ける。
 * >
 * > 同じく `USER-DEFINED`（pgvector の `vector` など）も本当の名前は `udt_name` にある。
 * >
 * > **単体テストはこの間違いを固定していた**（`$2::ARRAY` を正しいものとして書いていた）。
 * > 型の名前は information_schema の言い分ではなく、**Postgres が受け取るか**で決まる。
 */
export function castTypeOf(dataType: string, udtName: string): string {
  if (dataType === "ARRAY") return `${udtName.replace(/^_/, "")}[]`;
  if (dataType === "USER-DEFINED") return udtName;
  return dataType;
}

/** public スキーマの実テーブル。**書き並べない**——増えたテーブルを取り忘れないため。 */
export async function listTables(client: pg.ClientBase): Promise<string[]> {
  const res = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return res.rows.map((r) => r.table_name);
}

export async function columnsOf(client: pg.ClientBase, table: string): Promise<ColumnType[]> {
  const res = await client.query<{ column_name: string; data_type: string; udt_name: string }>(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return res.rows.map((r) => ({
    name: r.column_name,
    dataType: castTypeOf(r.data_type, r.udt_name),
  }));
}

/**
 * 戻せない形の列が無いか。**取る前に断る。**
 *
 * bytea は JSON へ写すと壊れる（Buffer が数値の配列になる）。いまの構成には無いが、
 * 将来入ったときに**壊れたバックアップを黙って取り続ける**方が悪い。
 */
export function unsupportedColumns(table: string, columns: ColumnType[]): string[] {
  return columns.filter((c) => c.dataType === "bytea").map((c) => `${table}.${c.name}`);
}

/** 行を書ける形にする。jsonb は文字列へ（配列の jsonb を配列型と取り違えないため）。 */
export function encodeRow(row: Record<string, unknown>, columns: ColumnType[]): unknown[] {
  return columns.map((c) => {
    const value = row[c.name];
    if (value === null || value === undefined) return null;
    if (c.dataType === "jsonb" || c.dataType === "json") return JSON.stringify(value);
    return value;
  });
}

export interface BackupOptions {
  databaseUrl: string;
  dest: string;
  keep: number;
  repoRoot: string;
  log?: (message: string) => void;
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
  removed: string[];
}

/**
 * 取る。**全テーブルを1つのスナップショットとして。**
 *
 * `REPEATABLE READ` の中で読むので、テーブルごとに時点がずれない。ずれると
 * 「メモは新しいが監査ログは古い」バックアップができ、戻したときに辻褄が合わない。
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const log = options.log ?? (() => {});
  assertSafeDestination(options.dest, options.repoRoot);

  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  const dir = join(options.dest, backupName(new Date()));
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await listTables(client);
    if (tables.length === 0) throw new Error("backup: テーブルが1つもありません（未 migrate？）");

    // 先に全部の列を見て、戻せない形があれば**取る前に**断る
    const blocked: string[] = [];
    const columns = new Map<string, ColumnType[]>();
    for (const table of tables) {
      const cols = await columnsOf(client, table);
      columns.set(table, cols);
      blocked.push(...unsupportedColumns(table, cols));
    }
    if (blocked.length > 0) {
      throw new Error(`backup: JSON へ写せない列があります: ${blocked.join(", ")}`);
    }

    mkdirSync(dir, { recursive: true });
    const rows: Record<string, number> = {};
    for (const table of tables) {
      const cols = columns.get(table) ?? [];
      const res = await client.query(`SELECT * FROM "${table}"`);
      const lines = res.rows.map((r) => JSON.stringify(encodeRow(r, cols)));
      writeFileSync(join(dir, `${table}.jsonl`), lines.length > 0 ? `${lines.join("\n")}\n` : "");
      writeFileSync(join(dir, `${table}.columns.json`), `${JSON.stringify(cols, null, 2)}\n`);
      rows[table] = res.rows.length;
      log(`  ${table}: ${res.rows.length}行`);
    }
    await client.query("COMMIT");

    const manifest: BackupManifest = {
      takenAt: new Date().toISOString(),
      database: safeDatabaseLabel(options.databaseUrl),
      rows,
    };
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // **書けたことと、取れたことは別。** 読み直して数える
    const mismatches = verifyBackup(dir, manifest);
    if (mismatches.length > 0) {
      throw new Error(`backup: 書いたものが数と合いません: ${mismatches.join(", ")}`);
    }

    const removed = pruneBackups(options.dest, options.keep);
    return { dir, manifest, removed };
  } finally {
    await client.end().catch(() => {});
  }
}

/** 書いたファイルを読み直し、目録と行数が合うか見る。合わない列を返す（空なら一致）。 */
export function verifyBackup(dir: string, manifest: BackupManifest): string[] {
  const bad: string[] = [];
  for (const [table, count] of Object.entries(manifest.rows)) {
    const text = readFileSync(join(dir, `${table}.jsonl`), "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== count) bad.push(`${table}（目録 ${count} / 実際 ${lines.length}）`);
  }
  return bad;
}

/** 古い分を消す。消したものを返す（**黙って消さない**）。 */
export function pruneBackups(dest: string, keep: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dest).filter((n) => statSync(join(dest, n)).isDirectory());
  } catch {
    return [];
  }
  const expired = expiredBackups(names, keep);
  for (const name of expired) rmSync(join(dest, name), { recursive: true, force: true });
  return expired;
}
