/**
 * マイグレーションランナー本体。
 *
 * 方針（§11・§12-7）:
 * - **起動時に CREATE TABLE をしない。** スキーマを作るのは `runMigrations`（= `pnpm migrate` から呼ぶ）だけ。
 *   アプリの起動経路は `assertSchemaReady` で「適用済みか」を確認するだけで、DDL を一切流さない。
 * - **適用済みは不変。** SQL を後から書き換えたら drift として検出して止める（改変された履歴で走らない）。
 * - **既定では contract を流さない。** 旧構造の撤去は新コードが行き渡った後の別デプロイ（3段の三段目）。
 * - **多重起動に耐える。** advisory lock で直列化し、各マイグレーションは1トランザクション。
 */

import { createHash } from "node:crypto";
import pg from "pg";
import {
  type AppliedMigration,
  type Migration,
  type MigrationDrift,
  type MigrationPhase,
  type MigrationSet,
  type MigrationStatus,
  PHASE_ORDER,
  type PendingMigration,
} from "./types.js";

/** 台帳。ランナー自身のブートストラップなので、これだけは `runMigrations` が作る。 */
const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  phase TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, id)
);`;

/** 名前空間が違っても同じ DB なら1つのロックで直列化する（DDL は相互に影響しうるため）。 */
const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('russell:schema_migrations'))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('russell:schema_migrations'))";

const ID_PATTERN = /^\d{4}_[a-z0-9_]+$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * 定義の健全性を検査する（DB 不要）。
 * ここで弾くのは「後から順序が壊れる」類の間違い。CI とテストで常に通す。
 */
export function validateMigrationSet(set: MigrationSet): void {
  if (!NAMESPACE_PATTERN.test(set.namespace)) {
    throw new Error(`migrate: 名前空間が不正です: "${set.namespace}"`);
  }
  let previous = "";
  const seen = new Set<string>();
  for (const m of set.migrations) {
    if (!ID_PATTERN.test(m.id)) {
      throw new Error(`migrate: id は "0001_init" 形式にしてください: "${set.namespace}/${m.id}"`);
    }
    if (seen.has(m.id)) {
      throw new Error(`migrate: id が重複しています: "${set.namespace}/${m.id}"`);
    }
    if (m.id <= previous) {
      throw new Error(
        `migrate: id は昇順で並べてください: "${set.namespace}/${m.id}" が "${previous}" の後ろにあります`,
      );
    }
    if (!(m.phase in PHASE_ORDER)) {
      throw new Error(`migrate: 未知の phase です: "${set.namespace}/${m.id}" の "${m.phase}"`);
    }
    if (m.sql.trim() === "") {
      throw new Error(`migrate: SQL が空です: "${set.namespace}/${m.id}"`);
    }
    seen.add(m.id);
    previous = m.id;
  }
}

/** 接続文字列（既定 env DATABASE_URL）からプールを作る。CLI 用の薄いヘルパ。 */
export function createMigrationPool(connectionString?: string): pg.Pool {
  const cs = connectionString ?? process.env.DATABASE_URL;
  if (!cs) throw new Error("migrate: DATABASE_URL が未設定です");
  return new pg.Pool({ connectionString: cs });
}

async function ledgerExists(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  const res = await db.query<{ reg: string | null }>(
    "SELECT to_regclass('schema_migrations') AS reg",
  );
  return Boolean(res.rows[0]?.reg);
}

async function readApplied(db: pg.Pool | pg.PoolClient): Promise<AppliedMigration[]> {
  const res = await db.query<{
    namespace: string;
    id: string;
    phase: MigrationPhase;
    checksum: string;
    applied_at: Date;
  }>(
    "SELECT namespace, id, phase, checksum, applied_at FROM schema_migrations ORDER BY namespace, id",
  );
  return res.rows.map((r) => ({
    namespace: r.namespace,
    id: r.id,
    phase: r.phase,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

function diff(
  sets: MigrationSet[],
  applied: AppliedMigration[],
): { pending: PendingMigration[]; drifted: MigrationDrift[] } {
  const byKey = new Map(applied.map((a) => [`${a.namespace}/${a.id}`, a]));
  const pending: PendingMigration[] = [];
  const drifted: MigrationDrift[] = [];
  for (const set of sets) {
    for (const m of set.migrations) {
      const hit = byKey.get(`${set.namespace}/${m.id}`);
      if (!hit) {
        pending.push({ namespace: set.namespace, id: m.id, phase: m.phase });
        continue;
      }
      const defined = checksumOf(m.sql);
      if (hit.checksum !== defined) {
        drifted.push({
          namespace: set.namespace,
          id: m.id,
          appliedChecksum: hit.checksum,
          definedChecksum: defined,
        });
      }
    }
  }
  return { pending, drifted };
}

/** 現況を返す（DDL は流さない・台帳も作らない）。 */
export async function migrationStatus(
  pool: pg.Pool,
  sets: MigrationSet[],
): Promise<MigrationStatus> {
  for (const set of sets) validateMigrationSet(set);
  if (!(await ledgerExists(pool))) {
    const pending = sets.flatMap((set) =>
      set.migrations.map((m) => ({ namespace: set.namespace, id: m.id, phase: m.phase })),
    );
    return { ledgerExists: false, applied: [], pending, drifted: [] };
  }
  const applied = await readApplied(pool);
  return { ledgerExists: true, applied, ...diff(sets, applied) };
}

export interface RunMigrationsOptions {
  /**
   * どの段階まで流すか。既定 `backfill`＝**contract は流さない**。
   * contract を含めるのは、新コードが全インスタンスに行き渡ったことを確認した後の別実行。
   */
  through?: MigrationPhase;
  log?: (message: string) => void;
}

export interface RunMigrationsResult {
  applied: PendingMigration[];
  /** `through` の指定で今回は見送ったもの（次のデプロイで流す）。 */
  deferred: PendingMigration[];
}

/**
 * 未適用のマイグレーションを名前空間ごとに id 昇順で適用する。
 * `through` を超える段階に当たったら、その名前空間の**そこから先は止める**
 * （飛ばして後ろを適用すると順序が壊れるため）。
 */
export async function runMigrations(
  pool: pg.Pool,
  sets: MigrationSet[],
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  for (const set of sets) validateMigrationSet(set);
  const through = options.through ?? "backfill";
  const log = options.log ?? (() => {});
  const limit = PHASE_ORDER[through];

  const client = await pool.connect();
  const applied: PendingMigration[] = [];
  const deferred: PendingMigration[] = [];
  try {
    // 台帳の作成も含めてロックの内側でやる。`CREATE TABLE IF NOT EXISTS` を
    // 複数セッションが同時に投げると一意制約違反で落ちることがあるため（PG の既知の挙動）。
    await client.query(LOCK_SQL);
    try {
      await client.query(LEDGER_SQL);
      // ロックを取ってから読み直す（他プロセスが先に適用しているかもしれない）
      const already = await readApplied(client);
      const drifted = diff(sets, already).drifted;
      if (drifted.length > 0) throw driftError(drifted);

      const doneKeys = new Set(already.map((a) => `${a.namespace}/${a.id}`));
      for (const set of sets) {
        let stopped = false;
        for (const m of set.migrations) {
          const ref: PendingMigration = { namespace: set.namespace, id: m.id, phase: m.phase };
          if (doneKeys.has(`${set.namespace}/${m.id}`)) continue;
          if (stopped || PHASE_ORDER[m.phase] > limit) {
            stopped = true;
            deferred.push(ref);
            continue;
          }
          await applyOne(client, set.namespace, m);
          log(`[migrate] applied ${set.namespace}/${m.id} (${m.phase})`);
          applied.push(ref);
        }
      }
    } finally {
      await client.query(UNLOCK_SQL);
    }
  } finally {
    client.release();
  }
  return { applied, deferred };
}

async function applyOne(client: pg.PoolClient, namespace: string, m: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(m.sql);
    await client.query(
      "INSERT INTO schema_migrations (namespace, id, phase, checksum) VALUES ($1, $2, $3, $4)",
      [namespace, m.id, m.phase, checksumOf(m.sql)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(
      `migrate: ${namespace}/${m.id} の適用に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function driftError(drifted: MigrationDrift[]): Error {
  const list = drifted.map((d) => `${d.namespace}/${d.id}`).join(", ");
  return new Error(
    `migrate: 適用済みマイグレーションの SQL が変更されています（${list}）。適用済みは不変です。修正は新しい版を追加してください（expand→backfill→contract）。`,
  );
}

/**
 * 起動時マイグレーション（dev/test の利便）が許される環境かを確かめる。
 * 本番で起動時に DDL を流さないことを**規約ではなくコードで**担保する（§11）。
 */
export function assertAutoMigrateAllowed(namespace: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `migrate: 本番で autoMigrate は使えません（${namespace}）。起動時 CREATE TABLE はしない規約です（§11）。デプロイ前に \`pnpm migrate\` を実行してください。`,
    );
  }
}

/**
 * 起動経路の検査（**DDL を流さない**）。未適用・改変・台帳なしのいずれでも throw する。
 * fail-closed（§12-7）: スキーマが想定と違う状態でアプリを動かさない。
 *
 * ただし **未適用の `contract` は正常**として通す。expand→backfill を当てて新コードを配り、
 * 全台が入れ替わってから contract を流す——という3段デプロイの途中状態がまさにそれで、
 * ここで止めると3段が回らなくなる（contract は旧構造の撤去なので、新コードは動く）。
 */
export async function assertSchemaReady(pool: pg.Pool, sets: MigrationSet[]): Promise<void> {
  const status = await migrationStatus(pool, sets);
  if (status.drifted.length > 0) throw driftError(status.drifted);
  const blocking = status.pending.filter((p) => p.phase !== "contract");
  if (blocking.length === 0) return;
  const list = blocking.map((p) => `${p.namespace}/${p.id}`).join(", ");
  throw new Error(
    status.ledgerExists
      ? `migrate: 未適用のマイグレーションがあります（${list}）。\`pnpm migrate\` を実行してください。`
      : `migrate: スキーマが未作成です（${list}）。\`pnpm migrate\` を実行してください（起動時 CREATE TABLE はしません, §11）。`,
  );
}
