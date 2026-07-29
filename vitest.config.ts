import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB を使うテストが同一 Postgres に対して並列に DDL（CREATE ... IF NOT EXISTS）を
    // 走らせると競合するため、テストファイルは直列に実行する。
    fileParallelism: false,
  },
});
