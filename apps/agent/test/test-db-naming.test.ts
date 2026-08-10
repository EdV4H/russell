/**
 * テスト専用 DB の名前づけ（DB 不要）。
 *
 * ここを間違えると**開発用 DB を作り直してしまう**ので、規則そのものを固定しておく。
 */

import { expect, test } from "vitest";
import { testDatabaseName, toTestDatabaseUrl } from "./test-db.js";

test("開発用 DB とは別の名前になる", () => {
  expect(toTestDatabaseUrl("postgres://u:p@localhost:5432/russell")).toBe(
    "postgres://u:p@localhost:5432/russell_test",
  );
  expect(testDatabaseName("postgres://u:p@localhost:5432/russell")).toBe("russell_test");
});

test("すでにテスト用なら二重に付けない（作り直す先がずれない）", () => {
  const url = "postgres://u:p@localhost:5432/russell_test";
  expect(testDatabaseName(url)).toBe("russell_test");
});

test("ホストや資格情報はそのまま引き継ぐ", () => {
  const url = new URL(toTestDatabaseUrl("postgres://user:pw@db.example:6543/app?sslmode=require"));
  expect(url.host).toBe("db.example:6543");
  expect(url.username).toBe("user");
  expect(url.searchParams.get("sslmode")).toBe("require");
});
