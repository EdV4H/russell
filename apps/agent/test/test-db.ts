/**
 * テスト専用 DB の名前づけ。
 *
 * **テストは開発用 DB に書かない。** 共有していると、ビューアで記憶を見たときに
 * テストが作った個体（`ks-…` `resil-…` `append-only-test`）が並び、本物の記憶が埋もれる。
 * 実際そうなっていて、Bob 本人の記憶が本1冊なのに全体では85冊、という状態になった。
 *
 * 名前を作るだけの純関数にしてあるのは、vitest の設定（テスト側の env を決める）と
 * globalSetup（DB を作る側）の両方から、同じ規則で呼ぶ必要があるため。
 */

/** `postgres://…/russell` → `postgres://…/russell_test`。既に `_test` なら足さない。 */
export function toTestDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  if (name.endsWith("_test")) return url.toString();
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** テスト DB の名前だけ（CREATE / DROP で使う）。 */
export function testDatabaseName(databaseUrl: string): string {
  return new URL(toTestDatabaseUrl(databaseUrl)).pathname.replace(/^\//, "");
}
