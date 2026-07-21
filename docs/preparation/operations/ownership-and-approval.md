# オーナーシップと承認体制

> [!NOTE]
> 準備物 C-2。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §6.1（`/ryo config` は管理者のみ）・§9（`granted_by`）・§12-2（スコープ付き事前承認）・§6.5（live 昇格）が源泉。
> 「認知と実行の分離」（§1-4）は技術ゲートだけでなく**人間の承認権限**でも担保する。誰が何を承認できるかを決めておく。

## 承認が必要な操作と権限（RACI）

R=実行 / A=最終承認 / C=相談 / I=通知。名前は TODO。

| 操作 | 設計書根拠 | R | A（承認権限） | C | I |
|---|---|---|---|---|---|
| **live 公開承認**（off/dryrun→live 昇格） | §6.5・§13 | 実装担当 | プロダクトオーナー | ドッグフーディング住人 | `#ryo-管理` |
| **装備支給/回収**（`issuances`, `granted_by`） | §9.1 | 実装担当 | 装備支給オーナー | セキュリティ | `#ryo-管理`・日報（§9.2） |
| **temperament 変更**（`/ryo config`） | §6.1 | — | config 管理者（管理者のみ） | — | `event_log`・`#ryo-管理` |
| **プリセット/ルーティンの公開版発行**（config_version） | §6.1 | 実装担当 | config 管理者 | プロダクトオーナー | `#ryo-管理` |
| **効果分類の追加/変更**（EffectClass） | §9・A-3 | 実装担当 | 発注側（セキュリティ） | — | PR レビュー |
| **参加チャンネルの追加**（読み取り対象） | §10・A-1 | 実装担当 | プロダクトオーナー + 対象チャンネル住人 | 人事/法務 | 住人告知（[`../dogfooding/plan.md`](../dogfooding/plan.md)） |
| **retention/削除依頼への対応**（「忘れて」の範囲） | A-1・§10.1 | 実装担当 | プライバシーオーナー（人事/法務） | — | 依頼者 |
| **キルスイッチ発動** | §12-4 | 権限者誰でも | 事後にオーナー | — | 全関係者（[`kill-switch.md`](./kill-switch.md)） |

## 権限とテーブルの対応

| 権限ロール | 実装上の紐付け |
|---|---|
| config 管理者 | `/ryo config` を叩ける Slack ユーザー（§6.1「管理者のみ」）。変更は `event_log` に残り config_version を発行 |
| 装備支給オーナー | `issuances.granted_by` に記録される主体（§9.1）。allowlist は issuances から機械生成（§9.2） |
| プロダクトオーナー | live 昇格・チャンネル追加の最終判断 |
| プライバシーオーナー | A-1 の記憶・公開・削除方針の番人（人事/法務） |

## 原則

- **セキュリティはプラグイン/外注に委ねない**（plugin-first: コアの Policy Gate 原値は緩和不可, [`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）。承認権限も同様に発注側が保持する（A-3）。
- スコープ付き事前承認（§12-2）は「毎回ボタン」の代替であって無承認ではない。承認は `操作種別 × 対象範囲 × config_version × 件数上限 × 有効期限` で記録する。config_version が変われば事前承認は失効し、再承認が要る。
- 承認の粒度は最小に。live 全解禁ではなく「この kind を、この config_version で、このチャンネルに」の単位。

## 承認フロー（live 昇格の例, §6.5）

1. dryrun で N 日分の Finding/習慣文面を `#ryo-管理` に出す（[`../dogfooding/plan.md`](../dogfooding/plan.md)）。
2. プロダクトオーナーが妥当率をレビュー（A-2 の判定手順、目安 70%）。
3. 承認 → config_version を発行して該当機能を live に。承認記録をスコープ付き事前承認として保存。
4. ロールバックは過去 config_version の再公開（§6.1）。

> [!TODO] 各承認ロールの担当者名の確定 — 承認者: プロダクトオーナー。
> - config 管理者: `<氏名>`
> - 装備支給オーナー: `<氏名>`
> - プロダクトオーナー: `<氏名>`
> - プライバシーオーナー（人事/法務）: `<氏名>`
> `/ryo config` を叩ける Slack ユーザー ID の allowlist もここで確定する。

> [!TODO] 承認の記録先の決定 — 承認者: 実装担当。event_log（§3.1）に加えて、人間が追える形（`#ryo-管理` のピン留め or Notion 台帳）を持つか。

関連: [`kill-switch.md`](./kill-switch.md) / [`incident-response.md`](./incident-response.md) / [`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md)（granted_by）/ [`../dogfooding/plan.md`](../dogfooding/plan.md)
