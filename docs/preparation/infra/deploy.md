# デプロイ手順

> [!IMPORTANT]
> **マイグレーション → 起動**の順序を守る。逆にすると、新しいコードが**起動しない**
> （スキーマが未適用なら fail-closed で止まる, §11）。止まるのは正しい振る舞いだが、
> 止まってから気づくより、順序で防ぐ方がよい。

## 順序

```
1. マイグレーション（expand → backfill）   ← 旧コードが動いたまま、新しい構造が入る
2. 新しいコードを起動
3. （必要なら）contract を別デプロイで      ← 旧構造の撤去。全台が入れ替わってから
```

**1 が失敗したら 2 へ進まない。** 半端な状態で起動させないため、デプロイの仕組み側で
「マイグレーションの成功」を条件にする。

- **Railway** — `railway.json` の `preDeployCommand`。失敗すればデプロイが止まる
- **docker compose** — `migrate` サービス（ワンショット）に
  `condition: service_completed_successfully` で依存させる（実装済み）
- **手で動かす場合** — `pnpm migrate && pnpm --filter @edv4h/russell-agent start`

## contract を分ける理由

`expand → backfill → contract` のうち、**`contract` は既定で流れない**。
`--contract` を明示したときだけである。

旧構造を撤去してよいのは、**新しいコードが全部のインスタンスに行き渡ってから**。
1つでも旧コードが残っていると、そのプロセスは無くなった列を触って落ちる。

```
pnpm migrate                 # 1回目のデプロイ前（expand・backfill）
（新コードのデプロイ・全台の入れ替えを確認）
pnpm migrate up --contract   # 2回目。ここで初めて旧構造が落ちる
```

**見送られたものは黙って消えない。** `pnpm migrate` は
`見送り <namespace>/<id> (contract) — 新コードの配布後に --contract で適用してください`
と出す。

## 適用済みの SQL は書き換えない

台帳（`schema_migrations`）が checksum を持っている。**書き換えると次回そこで止まる**
（勝手に直さない・黙って通さない）。直したいときは**新しいマイグレーションを足す**。

```
pnpm migrate status   # 適用済み / 未適用 / DRIFT を一覧。DRIFT があれば exit 1
```

## プロセスは3つ

| | 役割 | 起動前の確認 |
|---|---|---|
| **agent** | 会話（Slack 常駐） | プラグインが `assertSchemaReady`（自動） |
| **worker（dispatcher）** | 日報・整理などの定期実行 | 起動時に `assertSchemaReady`（自動） |
| **viewer** | 読み取り専用 UI | DB を見るだけ。外へ出すなら合言葉が要る（#81） |

**マイグレーションはどれか1つが担えばよい**（同じ台帳を見るので二重に流れない）。
Railway なら agent の `preDeployCommand` に置く。

## 新しい環境で最初に流すもの

`audit-pg` / `killswitch-pg` / `memory-pg` / `routines-pg` / `settings-pg` の全部が
未適用の状態から順に入る。**`pnpm migrate` 1回で足りる**（`pgvector` 拡張だけは
データベース側で有効化しておく）。

## 環境変数

[`setup-checklist.md`](./setup-checklist.md) を参照。デプロイ時に特に効くもの:

| | |
|---|---|
| `RUSSELL_MODE` | **既定は dryrun**。`live` を明示するまで外へ喋らない（§6.5） |
| `RUSSELL_KILL` | `1` で完全沈黙。**DB を読まない別経路**なので、DB 障害時にも効く（§12-7） |
| `RUSSELL_ALERT_CHANNEL` | 安全側に倒れたことの通知先。未設定ならログのみ（#25） |
| `RUSSELL_VIEWER_TOKEN` | ビューアを外へ出すなら必須。無いまま外向きにすると起動しない（#81） |

## バックアップと復元（#79）

**このプロダクトの価値は記憶そのものである。** 会話の文脈は Slack から取り直せるが
（ADR 0001）、メモ帳・本棚・単語帳・個人カルテ・日記・監査ログ・設定・予定は
Russell の DB にしかない。

```bash
pnpm --filter @edv4h/russell-worker backup                          # ~/.russell/backups へ
pnpm --filter @edv4h/russell-worker backup --dest /mnt/bk --keep 30
pnpm --filter @edv4h/russell-worker restore ~/.russell/backups/russell-20260824-170000
```

> [!IMPORTANT]
> **取れているが戻せない、が一番多い失敗である。** `restore` は既定で `<db>_restore` という
> **別の DB** に戻し、目録（テーブルごとの行数）と突き合わせて一致しなければ失敗で終わる。
> 確かめるたびに本物を壊す危険があると、人は確かめなくなる——だから確認は安全側を既定にし、
> 本物へ戻す `--into-live` の方を明示にしてある。

設計上の決めごと:

| | |
|---|---|
| 対象 | **DB にあるテーブル全部**（書き並べない。増えたテーブルを取り忘れないため） |
| 一貫性 | `REPEATABLE READ` の中で読む（テーブルごとに時点がずれない） |
| 確認 | 書いたファイルを**読み直して行数を数える**（書けたことと取れたことは別） |
| 置き場所 | **リポジトリの中は拒否**（機微情報の印が付いた行がある, ADR 0007） |
| 形式 | JSONL。スキーマは持ち歩かず、復元は `migrate` で作ってからデータを流す |
| 復元先 | 既定は `<db>_restore`。**空の DB にしか入れない**（`event_log` は消せない, §3.1） |

`pg_dump` は使っていない。手元に無いことがあり、バージョンを合わせる話が付いて回る。
記憶は千行の桁なので、素直に読み出す方が確実である。

**まだやっていないこと**: バックアップ自体の暗号化。鍵の置き場所を決める話になるので、
分けてある（いまはファイルの権限と置き場所だけで守っている）。マネージド Postgres を
使う場合は、そちらの自動バックアップと**併用**する——形式が違うので、片方が壊れても
もう片方が残る。
