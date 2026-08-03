/**
 * 横断ゲート「マイグレーション」のうち **DB 不要**で確かめられる部分（§11）。
 *
 * 検証すること:
 * 1. 実在のマイグレーション定義（audit-pg / memory-pg）が規約を満たす
 * 2. 順序が壊れる定義（重複・降順・不正 id・空 SQL）は定義段階で弾く
 * 3. 本番では起動時マイグレーション（autoMigrate）が**使えない**＝起動時 CREATE TABLE をしない
 */

import { createAgent } from "@edv4h/russell-core";
import {
  type MigrationSet,
  assertAutoMigrateAllowed,
  validateMigrationSet,
} from "@edv4h/russell-migrate";
import { AUDIT_MIGRATIONS, createPgAuditPlugin } from "@edv4h/russell-plugin-audit-pg";
import { MEMORY_MIGRATIONS, createPgMemoryPlugin } from "@edv4h/russell-plugin-memory-pg";
import type { Temperament } from "@edv4h/russell-shared";
import { afterEach, describe, expect, test } from "vitest";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

/** 接続はしない（production ガードで手前で落ちる）ので、届かないアドレスで十分。 */
const UNUSED_DSN = "postgres://unused:unused@127.0.0.1:1/unused";

describe("マイグレーション定義（DB 不要）", () => {
  test("プラグインの定義が規約を満たす", () => {
    expect(() => validateMigrationSet(AUDIT_MIGRATIONS)).not.toThrow();
    expect(() => validateMigrationSet(MEMORY_MIGRATIONS)).not.toThrow();
    // 名前空間が衝突すると台帳が混ざる
    expect(AUDIT_MIGRATIONS.namespace).not.toBe(MEMORY_MIGRATIONS.namespace);
  });

  test("順序が壊れる定義は弾く", () => {
    const base = (migrations: MigrationSet["migrations"]): MigrationSet => ({
      namespace: "demo",
      migrations,
    });
    // id 重複
    expect(() =>
      validateMigrationSet(
        base([
          { id: "0001_a", phase: "expand", sql: "SELECT 1" },
          { id: "0001_a", phase: "expand", sql: "SELECT 2" },
        ]),
      ),
    ).toThrow(/重複/);
    // 降順
    expect(() =>
      validateMigrationSet(
        base([
          { id: "0002_b", phase: "expand", sql: "SELECT 1" },
          { id: "0001_a", phase: "expand", sql: "SELECT 2" },
        ]),
      ),
    ).toThrow(/昇順/);
    // id 形式（連番が無いと辞書順が壊れる）
    expect(() =>
      validateMigrationSet(base([{ id: "init", phase: "expand", sql: "SELECT 1" }])),
    ).toThrow(/0001_init/);
    // 空 SQL
    expect(() =>
      validateMigrationSet(base([{ id: "0001_a", phase: "expand", sql: "  " }])),
    ).toThrow(/SQL が空/);
  });
});

describe("本番では起動時にスキーマを作らない（§11）", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original ?? "test";
  });

  test("autoMigrate は本番で拒否される", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertAutoMigrateAllowed("audit-pg")).toThrow(/本番で autoMigrate は使えません/);
    process.env.NODE_ENV = "test";
    expect(() => assertAutoMigrateAllowed("audit-pg")).not.toThrow();
  });

  test("本番で autoMigrate を渡したエージェントは起動しない", async () => {
    process.env.NODE_ENV = "production";
    await expect(
      createAgent({ agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun" }, [
        createPgAuditPlugin({ autoMigrate: true, connectionString: UNUSED_DSN }),
      ]),
    ).rejects.toThrow(/本番で autoMigrate は使えません/);

    await expect(
      createAgent({ agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun" }, [
        createPgMemoryPlugin({ autoMigrate: true, connectionString: UNUSED_DSN }),
      ]),
    ).rejects.toThrow(/本番で autoMigrate は使えません/);
  });
});
