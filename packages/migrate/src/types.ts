/**
 * マイグレーションの契約（設計書 §11「起動時 CREATE TABLE はしない。expand→backfill→contract」）。
 *
 * 名前空間はプラグイン単位。テーブルを持つのはプラグイン（memory-pg / audit-pg …）であり、
 * ランナーは「どの名前空間のどの版まで適用済みか」だけを台帳 `schema_migrations` で管理する。
 * これで plugin-first を崩さずに、DB は1つのまま（§2 マイクロサービス化しない）で済む。
 */

/**
 * 3段デプロイの段階（§11）。
 *
 * - `expand`   — 既存を壊さず足す（列追加・新テーブル・NULL 許容）。旧コードが動いたままでよい
 * - `backfill` — データを新構造へ移す。読み書き両対応の期間
 * - `contract` — 旧構造を撤去する。**新コードが全台に行き渡ってからでないと流せない**
 *
 * 既定の `up` は `backfill` までしか流さない。contract は明示指定を要求する（別デプロイに分ける）。
 */
export type MigrationPhase = "expand" | "backfill" | "contract";

/** 段階の適用順序。小さいほど先。 */
export const PHASE_ORDER: Record<MigrationPhase, number> = {
  expand: 0,
  backfill: 1,
  contract: 2,
};

export interface Migration {
  /** `0001_init` 形式。名前空間内で一意、**辞書順に適用**する。 */
  id: string;
  phase: MigrationPhase;
  /** 適用する SQL。1マイグレーション＝1トランザクション。 */
  sql: string;
}

export interface MigrationSet {
  /** 台帳の名前空間。プラグイン id から `russell-plugin-` を除いた短縮名（例 `audit-pg`）。 */
  namespace: string;
  migrations: Migration[];
}

/** 台帳に載っている適用済みレコード。 */
export interface AppliedMigration {
  namespace: string;
  id: string;
  phase: MigrationPhase;
  checksum: string;
  appliedAt: Date;
}

/** 未適用のマイグレーション（名前空間付き）。 */
export interface PendingMigration {
  namespace: string;
  id: string;
  phase: MigrationPhase;
}

/**
 * 適用済みなのに定義側の SQL が変わっている＝**改変**。
 * 適用済みマイグレーションは不変。直したい場合は新しい版を足す（それが expand→contract の作法）。
 */
export interface MigrationDrift {
  namespace: string;
  id: string;
  appliedChecksum: string;
  definedChecksum: string;
}

export interface MigrationStatus {
  /** 台帳テーブル自体が存在するか。false なら一度も migrate していない。 */
  ledgerExists: boolean;
  applied: AppliedMigration[];
  pending: PendingMigration[];
  drifted: MigrationDrift[];
}
