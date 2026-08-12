# リファレンス: キルスイッチ（`/russell stop` と `RUSSELL_KILL`）

設計書 §12-4（キルスイッチ）・§12-7（fail-closed / DB 障害時の別経路）を実装したもの。
横断必須ゲートのひとつ（[`test-strategy.md §5`](../preparation/acceptance/test-strategy.md)）。
**発動基準・権限者・連絡フローは運用側の1枚もの**
[`../preparation/operations/kill-switch.md`](../preparation/operations/kill-switch.md) が源泉で、ここは実装の記述。

## 3段階

コアが見るのは `runtime.freezeLevel()` が返す3値だけで、**どこから来た凍結かは問わない**。強い方が勝つ。

| レベル | 発動 | 経路 | 振る舞い |
|---|---|---|---|
| `silent` | `RUSSELL_KILL=1` を立てて再起動 | env（**DB を読まない**） | **完全沈黙**。応答も監査も外部 I/O も走らせない |
| `stopped` | `/russell stop [--all]` **または CLI** | DB（`agent_stops`） | 自発行動を凍結。mention には**固定文だけ**返す |
| `none` | — | — | 通常運転 |

> [!IMPORTANT] **決定（2026-08-12）: Slack を経由しない発動手段（#28）。**
> ```
> node apps/agent/dist/kill.js status
> node apps/agent/dist/kill.js stop [--all|--agent=<個体>] [--reason "理由"]
> node apps/agent/dist/kill.js start [--all|--agent=<個体>] --by <名前>
> ```
> 運用手順は「**迷ったら発動する**」と書いてあるのに、実際に使える手段が Slack か再起動しか
> 無かった。サーバーではその差がもっと効く（手元の psql が無い）。
>
> **発動は名前が無くても通る**（`--by` 省略で `cli`）。名前の有無で発動を妨げない。
> **解除には名前が要る**——誰が戻したか分からない解除を作らない。
> これはレベル1/2 なので、**DB が死んでいるときは効かない**。そのときはレベル3を使う。

```
$ # 凍結中に mention すると（レベル1/2）
いま止まっています（キルスイッチ発動中）。再開は運用担当者の解除を待ってください。
```

固定文（`FROZEN_NOTICE`）はモデルを通さない。凍結中に生成を走らせないため、かつ
「今止まっている」と言えた方が親切だから（決定 2026-07-23）。

## 読めないときは黙る

`agent_stops` を読めないときは **`silent` に倒す**。§12-7 は「ポリシー情報・承認記録・キルスイッチが
DB で読めないときは、外部送信・書き込みを行わない側に倒す」と定めていて、**停止中か分からないまま
「止まっています」と投稿するのも外部送信**だから。DB 障害で自動的に沈黙する側に倒れる。

env（レベル3）は DB を一切読まない。これが「DB 障害時にも効く別経路」の実体で、
テストでも *DB を1度も読んでいないこと* を確かめている（`killswitch.test.ts`）。

**倒れるのは判定であって、プロセスではない。** 接続プールのエラーを受けていないと、DB の再起動・
フェイルオーバで個体が落ちて監視の再起動ループに入る。各 pg プラグインは `pool.on("error")` を
持ち、落ちずに沈黙して、DB が戻れば応答に戻る（`pg-resilience.test.ts` が外から接続を切って確認）。

## 副作用の直前に再検査する

`freezeLevel()` はキャッシュを持たず、**副作用の直前に毎回読む**（§5.1）。

- ターン開始時（受信直後）
- ツール実行の Policy Gate 判定（`decide()`）
- **応答送信の直前** ← モデル呼び出しの数秒の間に発動されるのが実際に多い

数百 ms 古い値で1回投稿してしまうコストの方が、DB を1回読むコストより高い。

## `/russell` コマンド

Slack のスラッシュコマンド。認知ループを通さず通信面プラグインが直接処理する——
「止めろ」がモデル呼び出しや Policy Gate に依存していては、暴走時に効かない。

| コマンド | 範囲 |
|---|---|
| `/russell stop [理由]` | この個体 |
| `/russell stop --agent=alice [理由]` | 別個体（同じ DB を見ている個体に効く） |
| `/russell stop --all [理由]` | 全個体 |
| `/russell start [--agent=x\|--all]` | 解除（**権限者のみ**） |
| `/russell status` | 現在の凍結状態 |

- **曖昧な語は理由として扱い、自分を止める側に倒す。** `/russell stop spam` を「spam という個体を
  止める」と読むと、発動したつもりで暴走中の個体が動いたまま残る。個体指定は `--agent=` か、
  自分の個体名を明示したときだけ（`/russell stop bob`）
- 個体名は `^[a-z0-9][a-z0-9_-]{0,63}$` に限る。Slack の入力がそのまま DB のキーになるため（§12-3）
- 理由は `agent_stops.reason` に保存する（500字まで）。**監査 payload には長さしか入れない**（A1-5）

### 権限（非対称）

| 操作 | 誰が | なぜ |
|---|---|---|
| 発動 `stop` | **誰でも** | 「発動に承認は要らない・迷ったら発動する」（kill-switch.md）。誤発動より暴走のコストが高い |
| 解除 `start` | env `RUSSELL_KILL_OPERATORS`（Slack user id のカンマ区切り）にいる人だけ | 「解除は発動より慎重に」 |

`RUSSELL_KILL_OPERATORS` が**未設定なら誰も解除できない**。設定漏れが「誰でも解除できる」に
倒れてはいけない（fail-closed）。`RUSSELL_ADMIN_CHANNEL` を設定すると、発動・解除の記録を
そのチャンネルへ流す（kill-switch.md の連絡フロー）。

## 監査（発動と解除で順序が逆）

| action | いつ |
|---|---|
| `killswitch.engaged` | 発動を**適用した後**（記録できなくても凍結は成立させる） |
| `killswitch.released` | 解除の**前**（記録できなければ解除しない） |
| `turn.frozen` | 凍結中の mention に固定文を返した |
| `surface.send.suppressed` | ターンの途中で発動され、送信を止めた |
| `policy.denied` (`reason: "stopped"`) | 凍結中に状態を変えるツールが呼ばれた |

順序が非対称なのが要点。監査が壊れているときこそ止めたいのに「監査が残せないので止められません」では
守れない。逆に、凍結 → 通常運転という危険な方向の変更が誰にも追えないまま起きるのは防ぐ。

## 実装の在り処

| 場所 | 役割 |
|---|---|
| `packages/core/src/freeze.ts` | 3段階の判定（env → capability → fail-closed） |
| `@edv4h/russell-shared` `KillSwitchCapability` | 通常経路の契約。コアはこれしか知らない |
| `@edv4h/russell-plugin-killswitch-pg` | `agent_stops` の読み書き。マイグレーションもここ |
| `@edv4h/russell-plugin-surface-slack` `command.ts` / `killswitch-command.ts` | `/russell` の解釈と実行（Slack 非依存の純関数） |
| `apps/worker/src/main.ts` | 夜間バッチも起動前に確認する（バッチは自発行動そのもの） |

capability を持たない構成（オフライン stack・`DATABASE_URL` なし）では**レベル3だけが効く**。
`/russell stop` はその旨と env での止め方を返す。

## 残課題

- プロセスシグナル経路（`SIGUSR1` 等）は未実装。現状の別経路は env のみで、
  **発動には再起動が要る**（kill-switch.md のレベル3は「env を立ててデプロイ/再起動」と一致）
- 権限者ロスターは env で持っている。氏名の確定は
  [`ownership-and-approval.md`](../preparation/operations/ownership-and-approval.md) の担当者ロスター側

関連：[`31-core-api.md`](./31-core-api.md), [`34-migrations.md`](./34-migrations.md),
[`../preparation/operations/kill-switch.md`](../preparation/operations/kill-switch.md)
