import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB を使うテストが同一 Postgres に対して並列に DDL（CREATE ... IF NOT EXISTS）を
    // 走らせると競合するため、テストファイルは直列に実行する。
    fileParallelism: false,
    // 本番と同じ形でスキーマを用意する（テスト側で CREATE TABLE しない, §11）。
    globalSetup: ["apps/agent/test/global-setup.ts"],
  },
});
