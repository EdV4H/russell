# リファレンス: マイグレーション（`@edv4h/russell-migrate`）

設計書 §11 の「**起動時 CREATE TABLE はしない。expand→backfill→contract**」を実装したもの。
横断必須ゲートのひとつ（[`test-strategy.md §5`](../preparation/acceptance/test-strategy.md)）。

## 二つの経路を分ける

| 経路 | 誰が | 何をする |
|---|---|---|
| **適用** | `pnpm migrate`（`apps/agent/src/migrate.ts`）・compose の `migrate` サービス | DDL を流す。台帳に記録する |
| **起動** | `createAgent` → 各 pg プラグインの `setup` | **DDL を流さない**。適用済みかを確認するだけ |

未適用のまま起動しようとすると setup が throw してエージェントが立ち上がらない（fail-closed, §12-7）。
「テーブルが無ければ勝手に作る」を残すと、本番で意図しないスキーマが生える経路になるため塞いでいる。

```
$ pnpm dev                # スキーマ未適用の DB に対して
migrate: スキーマが未作成です（audit-pg/0001_event_log）。`pnpm migrate` を実行してください（起動時 CREATE TABLE はしません, §11）。
```

## 定義（プラグインが持つ）

テーブルを持つのはプラグインなので、マイグレーションもプラグインが持つ。ランナーは
「どの名前空間のどの版まで適用済みか」だけを見る。

```ts
// plugins/russell-plugin-audit-pg/src/migrations.ts
export const AUDIT_MIGRATIONS: MigrationSet = {
  namespace: "audit-pg",                 // 台帳の名前空間（プラグイン単位）
  migrations: [
    { id: "0001_event_log", phase: "expand", sql: `CREATE TABLE IF NOT EXISTS event_log (...)` },
  ],
};
```

- `id` は `0001_init` 形式・名前空間内で一意・**昇順**。この3点は `validateMigrationSet` が定義段階で弾く
- **適用済みの SQL は書き換えない。** checksum を台帳に持っていて、変わっていたら drift として止まる。
  直したいときは新しい版を足す（それ自体が expand→contract の作法）
- 使うテーブル群を集めるのは組み立てホスト（`apps/agent/src/migrate.ts` の `SETS`）。
  プラグインを増やしたらここに足す — `main.ts` がプラグイン配列を組むのと同じ役割

## 3段デプロイ

`phase` は「いつ流してよいか」を表す。

| phase | 内容 | いつ |
|---|---|---|
| `expand` | 既存を壊さず足す（列追加・新テーブル・NULL 許容） | 新コードのデプロイ**前**。旧コードが動いたままでよい |
| `backfill` | データを新構造へ移す | 同上。読み書き両対応の期間 |
| `contract` | 旧構造を撤去する | 新コードが**全インスタンスに行き渡ってから** |

手順:

```bash
pnpm migrate                # 1. expand + backfill（contract は流さない ← 既定）
#                             2. 新コードをデプロイ、全台の入れ替わりを待つ
pnpm migrate up --contract  # 3. 旧構造を落とす
```

- 既定が `--through backfill` なので、**うっかり同じデプロイで旧構造を落とすことがない**。
  見送った分は `[migrate] 見送り demo/0004_drop_old (contract)` と出る
- `contract` に当たったらその名前空間の**そこから先は止める**（飛ばして後ろを適用すると順序が壊れる）
- 未適用の `contract` があってもアプリは起動する。それが3段の途中の正常な状態だから

## 台帳と安全装置

```sql
CREATE TABLE schema_migrations (
  namespace TEXT NOT NULL, id TEXT NOT NULL, phase TEXT NOT NULL,
  checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, id)
);
```

- **advisory lock** で直列化。複数インスタンスが同時に `pnpm migrate` しても二重適用しない
- 各マイグレーションは**1トランザクション**。失敗したら台帳にも載らない
- `autoMigrate`（dev/test 用の起動時適用）は `NODE_ENV=production` で**拒否**する。
  規約ではなくコードで担保する

## API

| 関数 | 用途 |
|---|---|
| `runMigrations(pool, sets, { through })` | 適用する。**唯一 DDL を流す経路** |
| `assertSchemaReady(pool, sets)` | 起動時の確認。未適用・drift なら throw（`contract` の未適用は通す） |
| `migrationStatus(pool, sets)` | 適用済み / 未適用 / drift の一覧（`pnpm migrate status`） |
| `validateMigrationSet(set)` | 定義の検査（DB 不要） |
| `assertAutoMigrateAllowed(ns)` | 本番で起動時適用を使っていないか |

## 権限（残課題）

トリガで塞げるのは DML（`event_log` の UPDATE/DELETE/TRUNCATE）まで。`DROP TABLE` は塞げないので、
**アプリ用ロールに DDL 権限を与えない**（マイグレーション専用ロールと分ける）運用が要る（§12-6 最小権限）。
これは [`../preparation/infra/setup-checklist.md`](../preparation/infra/setup-checklist.md) 側の未対応項目。

関連：[`../concepts/19-data-model.md`](../concepts/19-data-model.md), [`33-package-layout.md`](./33-package-layout.md)
