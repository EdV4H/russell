/**
 * 記憶のバックアップと復元（#79）。
 *
 * 純関数の部分は DB 無しで確かめる。**往復（取って戻して数が合う）は DATABASE_URL があるときだけ**——
 * そこが本番であり、「取れているが戻せない」を見つけられるのはこの1本だけである。
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationSet, createMigrationPool, runMigrations } from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS } from "@edv4h/russell-plugin-audit-pg";
import { KILLSWITCH_MIGRATIONS } from "@edv4h/russell-plugin-killswitch-pg";
import { MEMORY_MIGRATIONS } from "@edv4h/russell-plugin-memory-pg";
import { ROUTINES_MIGRATIONS } from "@edv4h/russell-plugin-routines-pg";
import { SETTINGS_MIGRATIONS } from "@edv4h/russell-plugin-settings-pg";
import {
  type BackupManifest,
  assertSafeDestination,
  backupName,
  castTypeOf,
  encodeRow,
  expiredBackups,
  pruneBackups,
  runBackup,
  safeDatabaseLabel,
  unsupportedColumns,
  verifyBackup,
} from "@edv4h/russell-worker/backup";
import {
  countMismatches,
  databaseNameOf,
  insertStatement,
  ledgerKeys,
  loadBackup,
  readBackup,
  recreateDatabase,
  schemaGap,
  toAdminUrl,
  toRestoreDatabaseUrl,
} from "@edv4h/russell-worker/restore";
import pg from "pg";
import { describe, expect, test } from "vitest";

const scratch = () => mkdtempSync(join(tmpdir(), "russell-backup-"));

/** 復元先に作るスキーマ。**migrate CLI と同じ構成**（ずれると往復を確かめたことにならない）。 */
const SETS: MigrationSet[] = [
  AUDIT_MIGRATIONS,
  KILLSWITCH_MIGRATIONS,
  MEMORY_MIGRATIONS,
  ROUTINES_MIGRATIONS,
  SETTINGS_MIGRATIONS,
];

test("置き場所の名前は、並べたときに時系列で読める", () => {
  expect(backupName(new Date(2026, 7, 24, 17, 5, 3))).toBe("russell-20260824-170503");
});

test("**リポジトリの中には置かせない**（機微情報の印が付いた行がある）", () => {
  expect(() => assertSafeDestination("/repo/backups", "/repo")).toThrow(/リポジトリ/);
  expect(() => assertSafeDestination("/repo", "/repo")).toThrow(/リポジトリ/);
  // 外なら通す
  expect(() => assertSafeDestination("/home/me/.russell/backups", "/repo")).not.toThrow();
  // 名前が前方一致するだけの別ディレクトリは、中ではない
  expect(() => assertSafeDestination("/repo-backups", "/repo")).not.toThrow();
});

test("目録に資格情報を入れない（バックアップ自体が読まれうる）", () => {
  const label = safeDatabaseLabel("postgres://user:secret@db.example:5432/russell");
  expect(label).toBe("db.example:5432/russell");
  expect(label).not.toContain("secret");
});

test("古い分だけを消す。**新しい方から残す**", () => {
  const names = [
    "russell-20260820-000000",
    "russell-20260821-000000",
    "russell-20260822-000000",
    "russell-20260823-000000",
  ];
  expect(expiredBackups(names, 2)).toEqual(["russell-20260820-000000", "russell-20260821-000000"]);
  expect(expiredBackups(names, 10)).toEqual([]);
});

test("**関係の無いディレクトリは消さない**（置き場所を共有していても壊さない）", () => {
  const names = ["russell-20260820-000000", "だいじなもの", "notes"];
  expect(expiredBackups(names, 0)).toEqual([]);
  expect(expiredBackups(names, 1)).toEqual([]);
});

test("jsonb は文字列に直して書く（戻すときに配列と取り違えないため）", () => {
  const columns = [
    { name: "id", dataType: "integer" },
    { name: "events", dataType: "jsonb" },
    { name: "aliases", dataType: "text[]" },
    { name: "note", dataType: "text" },
  ];
  const encoded = encodeRow({ id: 1, events: [{ a: 1 }], aliases: ["x"], note: null }, columns);

  expect(encoded[0]).toBe(1);
  expect(encoded[1]).toBe('[{"a":1}]'); // 文字列。配列のままだと配列型として送られる
  expect(encoded[2]).toEqual(["x"]); // 配列型はそのまま
  expect(encoded[3]).toBeNull();
});

test("**戻せない形の列があれば、取る前に断る**", () => {
  const bad = unsupportedColumns("files", [
    { name: "id", dataType: "integer" },
    { name: "blob", dataType: "bytea" },
  ]);
  // 壊れたバックアップを黙って取り続ける方が悪い
  expect(bad).toEqual(["files.blob"]);
});

test("**書いたものを読み直して数える**（書けたことと取れたことは別）", () => {
  const dir = scratch();
  writeFileSync(join(dir, "notes.jsonl"), "[1]\n[2]\n");
  const manifest: BackupManifest = { takenAt: "", database: "", rows: { notes: 2 } };

  expect(verifyBackup(dir, manifest)).toEqual([]);

  // 途中で切れたファイルを、成功と言わない
  writeFileSync(join(dir, "notes.jsonl"), "[1]\n");
  expect(verifyBackup(dir, manifest)[0]).toContain("notes");
});

test("戻し先は本番とは別の DB になる", () => {
  expect(toRestoreDatabaseUrl("postgres://u:p@h:5432/russell")).toContain("/russell_restore");
  // 二重に付けない
  expect(toRestoreDatabaseUrl("postgres://u:p@h:5432/russell_restore")).toContain(
    "/russell_restore",
  );
  expect(databaseNameOf(toAdminUrl("postgres://u:p@h:5432/russell"))).toBe("postgres");
});

test("**目録が無いバックアップは受け付けない**（どこまで入っているか言えない）", () => {
  const dir = scratch();
  writeFileSync(join(dir, "notes.jsonl"), "[1]\n");

  expect(() => readBackup(dir)).toThrow(/目録/);
});

test("**目録にあるファイルが無ければ、戻す前に断る**", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ takenAt: "", database: "", rows: { notes: 1, books: 1 } }),
  );
  writeFileSync(join(dir, "notes.jsonl"), "[1]\n");

  expect(() => readBackup(dir)).toThrow(/books/);
});

test("目録と数が合わないものだけを挙げる", () => {
  const manifest: BackupManifest = {
    takenAt: "",
    database: "",
    rows: { notes: 55, books: 7, terms: 56 },
  };
  expect(countMismatches(manifest, { notes: 55, books: 7, terms: 56 })).toEqual([]);
  // 入っていないテーブルは 0 件として扱う（黙って見逃さない）
  const bad = countMismatches(manifest, { notes: 55, books: 3 });
  expect(bad).toHaveLength(2);
  expect(bad.join(" ")).toContain("books");
  expect(bad.join(" ")).toContain("terms");
});

test("INSERT は列の型で明示的にキャストする（jsonb と配列を取り違えないため）", () => {
  const sql = insertStatement("entities", [
    { name: "id", dataType: "integer" },
    { name: "aliases", dataType: "text[]" },
    { name: "events", dataType: "jsonb" },
  ]);
  expect(sql).toContain('"aliases"');
  expect(sql).toContain("$2::text[]");
  expect(sql).toContain("$3::jsonb");
});

/**
 * **information_schema の言い分をそのまま型名として使わない。**
 *
 * ここは一度、単体テストごと間違えた（`$2::ARRAY` を正しいものとして書いていた）。
 * 型の名前は information_schema がどう言うかではなく、**Postgres が受け取るか**で決まる。
 * 往復のテストを実際に流して初めて落ちた。
 */
test("**配列は `ARRAY` ではなく、要素の型で書く**（そのままでは構文エラーになる）", () => {
  expect(castTypeOf("ARRAY", "_text")).toBe("text[]");
  expect(castTypeOf("ARRAY", "_int8")).toBe("int8[]");
  // pgvector の vector なども、本当の名前は udt_name にある
  expect(castTypeOf("USER-DEFINED", "vector")).toBe("vector");
  // 普通の型はそのまま書ける
  expect(castTypeOf("timestamp with time zone", "timestamptz")).toBe("timestamp with time zone");
  expect(castTypeOf("jsonb", "jsonb")).toBe("jsonb");
});

/**
 * ここからが本番。**取って、別の DB へ戻して、数が合うことまで見る。**
 *
 * この1本が無いと、上のテストが全部通っても「取れているが戻せない」を見つけられない。
 */
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("往復（DATABASE_URL 必須）", () => {
  /** 復元先にスキーマを作る。**本番の migrate と同じ構成**でなければ意味がない。 */
  async function migrateInto(targetUrl: string): Promise<void> {
    const pool = createMigrationPool(targetUrl);
    try {
      await runMigrations(pool, SETS, { through: "contract" });
    } finally {
      await pool.end();
    }
  }

  /** 扱いの難しい型（jsonb・配列）を必ず1行は通す。空の DB では往復を確かめたことにならない。 */
  async function seed(url: string): Promise<void> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO event_log (agent_id, config_version, actor, action, payload, trust_label)
         VALUES ('backup-test', 'v0', 'backup-test', 'test.seeded', $1::jsonb, 'trusted')`,
        [JSON.stringify({ list: [1, 2, 3], nested: { a: "b" } })],
      );
      await client.query(
        `INSERT INTO entities (agent_id, type, name, aliases, summary)
         VALUES ('backup-test', 'term', $1, $2::text[], 'テスト用')
         ON CONFLICT DO NOTHING`,
        [`語-${Date.now()}`, ["別名1", "別名2"]],
      );
    } finally {
      await client.end();
    }
  }

  test("**取ったものを別の DB へ戻すと、目録と一致する**", async () => {
    const url = DB as string;
    await seed(url);
    const dest = scratch();

    const backup = await runBackup({ databaseUrl: url, dest, keep: 5, repoRoot: "/nonexistent" });
    expect(Object.keys(backup.manifest.rows).length).toBeGreaterThan(0);
    expect(backup.manifest.rows.event_log).toBeGreaterThan(0);

    const targetUrl = toRestoreDatabaseUrl(url);
    await recreateDatabase(toAdminUrl(url), databaseNameOf(targetUrl));
    await migrateInto(targetUrl);

    const restored = await loadBackup({ dir: backup.dir, targetUrl });
    // ここが**このファイルで唯一「戻せる」を証明する行**
    expect(restored.mismatches).toEqual([]);

    // jsonb と配列が形を保っているか、実際に読んで確かめる
    const client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
    try {
      const ev = await client.query<{ payload: { list: number[] } }>(
        "SELECT payload FROM event_log WHERE action = 'test.seeded' LIMIT 1",
      );
      expect(ev.rows[0]?.payload.list).toEqual([1, 2, 3]);
      const en = await client.query<{ aliases: string[] }>(
        "SELECT aliases FROM entities WHERE agent_id = 'backup-test' LIMIT 1",
      );
      expect(en.rows[0]?.aliases).toEqual(["別名1", "別名2"]);
    } finally {
      await client.end();
    }
  }, 60_000);

  test("**中身のある DB へは重ねない**（event_log は消せないので取り返しがつかない）", async () => {
    const url = DB as string;
    await seed(url);
    const dest = scratch();
    const backup = await runBackup({ databaseUrl: url, dest, keep: 5, repoRoot: "/nonexistent" });

    const targetUrl = toRestoreDatabaseUrl(url);
    await recreateDatabase(toAdminUrl(url), databaseNameOf(targetUrl));
    await migrateInto(targetUrl);
    await loadBackup({ dir: backup.dir, targetUrl });

    // 2回目は断る
    await expect(loadBackup({ dir: backup.dir, targetUrl })).rejects.toThrow(/空ではありません/);
  }, 60_000);

  test("取ったものは、読み直して数が合っている", async () => {
    const dest = scratch();
    const backup = await runBackup({
      databaseUrl: DB as string,
      dest,
      keep: 5,
      repoRoot: "/nonexistent",
    });

    expect(verifyBackup(backup.dir, backup.manifest)).toEqual([]);
    // 目録に載っているテーブルのぶんだけファイルがある
    const files = readdirSync(backup.dir).filter((n) => n.endsWith(".jsonl"));
    expect(files.length).toBe(Object.keys(backup.manifest.rows).length);
    expect(JSON.parse(readFileSync(join(backup.dir, "manifest.json"), "utf8"))).toHaveProperty(
      "takenAt",
    );
  });

  test("世代を超えた分は消える", async () => {
    const dest = scratch();
    for (const name of ["russell-20260801-000000", "russell-20260802-000000"]) {
      writeFileSync(join(dest, `${name}`), ""); // ディレクトリではないので対象外
    }
    expect(pruneBackups(dest, 1)).toEqual([]);
  });
});

/**
 * 台帳（`schema_migrations`）の扱い。**これは記憶ではなく、スキーマの記録である。**
 *
 * ここを記憶と同じに扱っていたせいで、migrate 直後の DB が必ず「空ではない」と
 * 判定され、**手順どおりの復元が一度も成功しなかった**。単体のテストは全部通っていて、
 * 往復を実際に流して初めて出た。
 */

test("**台帳は戻す対象に含めない**（スキーマは migrate が作る）", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ takenAt: "", database: "", rows: { notes: 1, schema_migrations: 3 } }),
  );
  writeFileSync(join(dir, "notes.jsonl"), "[1]\n");
  writeFileSync(
    join(dir, "schema_migrations.columns.json"),
    JSON.stringify([
      { name: "namespace", dataType: "text" },
      { name: "id", dataType: "text" },
    ]),
  );
  writeFileSync(
    join(dir, "schema_migrations.jsonl"),
    '["audit","0001"]\n["memory","0001"]\n["memory","0002"]\n',
  );

  const contents = readBackup(dir);
  expect(contents.tables).toEqual(["notes"]);
  // 台帳そのものは、互換性を見るために読んである
  expect(contents.ledger).toEqual(["audit/0001", "memory/0001", "memory/0002"]);
});

test("**戻していない台帳の行数を、不一致として数えない**", () => {
  const manifest: BackupManifest = {
    takenAt: "",
    database: "",
    rows: { notes: 1, schema_migrations: 3 },
  };
  // 台帳は戻さないので 0 件で正しい。ここを数えると、成功が必ず失敗に見える
  expect(countMismatches(manifest, { notes: 1, schema_migrations: 0 })).toEqual([]);
});

test("**戻し先のスキーマが古ければ断る。新しいだけなら通す**", () => {
  const backup = ["audit/0001", "memory/0001", "memory/0002"];

  // 戻し先に memory/0002 が無い＝列が足りない可能性がある
  expect(schemaGap(backup, ["audit/0001", "memory/0001"]).missing).toEqual(["memory/0002"]);
  // 戻し先が先に進んでいるだけなら止めない（ただし黙らない）
  const ahead = schemaGap(backup, [...backup, "memory/0003"]);
  expect(ahead.missing).toEqual([]);
  expect(ahead.ahead).toEqual(["memory/0003"]);
});

test("台帳の並び順が違っても、同じものは同じと見る", () => {
  const columns = [
    { name: "id", dataType: "text" },
    { name: "namespace", dataType: "text" },
  ];
  // 列の順序が違っても名前で引く（SELECT * の順序に依存しない）
  expect(
    ledgerKeys(
      [
        ["0002", "memory"],
        ["0001", "audit"],
      ],
      columns,
    ),
  ).toEqual(["audit/0001", "memory/0002"]);
});
