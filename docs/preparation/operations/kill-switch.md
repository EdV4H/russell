# キルスイッチ（1枚もの）

> [!NOTE]
> 準備物 C-2。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §12-4（キルスイッチ）・§12-7（fail-closed / DB 障害時の別経路）が源泉。
> **この1枚を印刷/ピン留めして、緊急時に迷わず発動できる状態にしておく。**

## いつ発動するか（発動基準）

以下のいずれかで即発動。迷ったら発動する（誤発動のコストより暴走のコストが高い）。

- 機微情報・秘匿情報を本番チャンネルに投稿した/しそう（A-1 違反）
- 誤送信・連投・同じ通知の繰り返し（outbound 暴走）
- 明らかに的外れ/有害な自発発言が続く
- 外部システム（Notion/GitHub）への意図しない書き込み
- 記憶汚染（memory poisoning）の疑い（[`incident-response.md`](./incident-response.md)）
- コストの急騰（使用量台帳アラート, [`cost-budget.md`](./cost-budget.md)）
- 原因不明の異常挙動全般

## 誰が発動できるか（権限者）

**発動に承認は要らない。** 権限者なら誰でも単独で発動でき、事後にオーナーへ報告する。

| ロール | 発動権限 |
|---|---|
| プロダクトオーナー | ○ |
| config 管理者 | ○ |
| 実装/運用担当（オンコール） | ○ |
| ドッグフーディング住人 | `/russell stop`（個体単位）は○。全体停止は権限者へ即連絡 |

> [!TODO] 権限者の氏名・オンコール担当・連絡先（電話/Slack DM）は [`ownership-and-approval.md`](./ownership-and-approval.md) の**担当者ロスター**（「キルスイッチ権限者/オンコール」行）で一括確定する。ここでは氏名を重複管理しない。

## どう発動するか（発動方法）

段階と経路を2系統持つ（§12-4・§12-7）。

| レベル | 方法 | 範囲 | 効き方 |
|---|---|---|---|
| 1. 個体単位・通常経路 | Slack で `/russell stop`（別個体は `/russell stop --agent=<個体名>`） | その個体の全自発行動を凍結 | DB 経由。副作用の直前に再検査（§5.1） |
| 2. 全体・通常経路 | `/russell stop --all` | 全個体を凍結 | DB 経由 |
| 3. 全体・別経路（fail-closed） | **環境変数フラグ `RUSSELL_KILL=1`** を立ててデプロイ/再起動、またはプロセスシグナル | 全個体・DB 障害時にも効く | env/シグナル。DB を読めなくても発火（§12-7） |

- キルスイッチは **DB 障害時にも効く別経路（env / プロセスシグナル）を必ず持つ**（§12-7）。ポリシー情報・承認記録・キルスイッチが DB で読めないときは、外部送信・書き込みを行わない側に倒す（fail-closed）。
- 凍結対象は**自発行動**（気づき・習慣・学習された習慣・自動起票）。mention への最低限の応答を残すか完全沈黙かはレベルで選ぶ（下記 TODO）。
- env フラグは Secret Manager ではなく env/シグナルで持つ（[`../infra/setup-checklist.md`](../infra/setup-checklist.md) の該当 TODO と一致）。

## 発動後の連絡フロー

```
発動
 → #russell-管理 に自動で「キルスイッチ発動: <個体/全体> / 発動者 / 理由 / 時刻」を記録
 → 発動者がオーナー（プロダクトオーナー）に即連絡
 → 影響範囲を確認（何を投稿した/書き込んだか event_log で追う, §3.1）
 → インシデント対応へ（incident-response.md）
 → 原因除去・config_version rollback 後、オーナー承認で解除
```

- 解除は発動より慎重に。原因が特定・除去され、オーナーが承認するまで凍結を維持する。
- 解除後しばらくは dryrun に落として様子を見る（§6.5）。

> [!IMPORTANT] **決定（2026-07-23）: 凍結粒度と env フラグを確定。** レベル1/2（`/russell stop`）は**自発行動のみ凍結し mention への最低限の応答は残す**（「今止まってます」を返せる方が親切・状況説明できる）。レベル3（`RUSSELL_KILL=1` / シグナル）は**完全沈黙**（fail-closed の最終手段）。env フラグ名 = `RUSSELL_KILL`。
>
> [!NOTE] **実装済み（2026-08-05）。** 契約と挙動は [`../../reference/35-killswitch.md`](../../reference/35-killswitch.md)。運用に効く差分:
>
> - **解除できるのは env `RUSSELL_KILL_OPERATORS`（Slack user id のカンマ区切り）にいる人だけ。未設定なら誰も解除できない。** 発動は誰でもできる（この1枚の「発動に承認は要らない」をそのまま実装）
> - `RUSSELL_ADMIN_CHANNEL` を設定すると発動・解除が自動でそのチャンネルに流れる（下の連絡フロー）
> - `/russell stop <個体名>` は自分の個体名のときだけ通る。曖昧な語（`/russell stop spam` など）は**理由**として扱い、**自分を止める**側に倒れる。別個体を止めるときは `--agent=<個体名>`
> - **凍結状態が読めないときは完全沈黙**（`/russell status` も含めて応答しない）。DB 障害では自動的に止まる側に倒れる
> - `RUSSELL_KILL` の別経路が確実に効くことは起動テストで確認済み（`apps/agent/test/killswitch.test.ts`: DB を1度も読まずに沈黙する）。**プロセスシグナル経路は未実装**で、レベル3の発動には再起動が要る

関連: [`incident-response.md`](./incident-response.md) / [`ownership-and-approval.md`](./ownership-and-approval.md) / [`../infra/setup-checklist.md`](../infra/setup-checklist.md) / [`../dogfooding/plan.md`](../dogfooding/plan.md)（切る基準）
