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

> [!TODO] 権限者の氏名と、オンコール担当・連絡先（電話/Slack DM）の確定 — 承認者: プロダクトオーナー。[`ownership-and-approval.md`](./ownership-and-approval.md) のロールと一致させる。

## どう発動するか（発動方法）

段階と経路を2系統持つ（§12-4・§12-7）。

| レベル | 方法 | 範囲 | 効き方 |
|---|---|---|---|
| 1. 個体単位・通常経路 | Slack で `/russell stop <個体名>` | その個体の全自発行動を凍結 | DB 経由。副作用の直前に再検査（§5.1） |
| 2. 全体・通常経路 | `/russell stop --all` | 全個体を凍結 | DB 経由 |
| 3. 全体・別経路（fail-closed） | **環境変数フラグ**（例 `RYO_KILL=1`）を立ててデプロイ/再起動、またはプロセスシグナル | 全個体・DB 障害時にも効く | env/シグナル。DB を読めなくても発火（§12-7） |

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

> [!TODO] 凍結の粒度（mention 応答も止めるか、自発行動のみ止めるか）と、env フラグ名・シグナルの確定 — 承認者: 実装担当 + プロダクトオーナー。DB 障害時の別経路が確実に効くことを起動テストで検証する（§12-7）。

関連: [`incident-response.md`](./incident-response.md) / [`ownership-and-approval.md`](./ownership-and-approval.md) / [`../infra/setup-checklist.md`](../infra/setup-checklist.md) / [`../dogfooding/plan.md`](../dogfooding/plan.md)（切る基準）
