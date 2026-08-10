import { defineConfig } from "vitest/config";
import { toTestDatabaseUrl } from "./apps/agent/test/test-db.js";

// **テストは開発用 DB に書かない。** テスト側だけ `<db>_test` を向ける。
// DB そのものは globalSetup が作り直す（そちらは開発用 DB を見て CREATE する）。
const devUrl = process.env.DATABASE_URL;

export default defineConfig({
  test: {
    env: devUrl ? { DATABASE_URL: toTestDatabaseUrl(devUrl) } : {},
    // DB を使うテストが同一 Postgres に対して並列に DDL（CREATE ... IF NOT EXISTS）を
    // 走らせると競合するため、テストファイルは直列に実行する。
    fileParallelism: false,
    // 本番と同じ形でスキーマを用意する（テスト側で CREATE TABLE しない, §11）。
    globalSetup: ["apps/agent/test/global-setup.ts"],
  },
});
