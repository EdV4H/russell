# インシデント対応手順（ドラフト）

> [!NOTE]
> 準備物 C-2。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §12（セキュリティ・ガードレール）全般、特に §12-4（キルスイッチ）・§12-5（記憶の来歴）・§6.1（config_version）が源泉。
> 共通フロー: **検知 → 封じ込め（キルスイッチ）→ 復旧 → 事後**。3タイプ（誤送信 / 記憶汚染 / 暴走）で誰が何をするかを定める。

## 共通フロー

```
検知 → 封じ込め（/russell stop or env フラグ, kill-switch.md）
     → 影響範囲の特定（event_log で全アクション追跡, §3.1）
     → 復旧（config_version rollback / 記憶の来歴で汚染追跡, §12-5）
     → 事後（原因・再発防止・報告者への還元）
```

- 検知したら**まず封じ込め**。原因分析は封じ込めの後（暴走は時間とともに被害が増える）。
- event_log は追記専用の監査ログ（§3.1）。「誰が/何を/いつ/trust_label」が残るので、影響特定はここを起点にする。
- 対応の記録自体も `#russell-管理` に残し、後で事後レビューできるようにする。

## 役割

| ロール | 責務 |
|---|---|
| 発見者 | 検知・一次封じ込め（`/russell stop`）・`#russell-管理` へ第一報 |
| インシデント指揮（オーナー） | 影響判断・復旧承認・対外連絡の要否判断 |
| 実装/運用担当 | ログ追跡・rollback 実行・原因除去 |
| プライバシーオーナー | 機微情報流出時の労務/法務対応（A-1） |

> [!TODO] 各ロールの担当者と、就業時間外の連絡フローの確定 — 承認者: プロダクトオーナー（[`kill-switch.md`](./kill-switch.md) の権限者と一致）。

---

## タイプ1: 誤送信（機微情報・宛先誤り・連投）

| 段階 | 誰が | 何をする |
|---|---|---|
| 検知 | 発見者（住人含む） | `#russell-管理` へ第一報。何が/どこに出たかを添える |
| 封じ込め | 発見者/運用 | `/russell stop <個体名>`。連投なら outbound circuit breaker（§12-8）が効いているか確認、効いていなければ全体停止 |
| 影響特定 | 運用 | event_log で送信内容・宛先・件数を洗う。機微情報が含まれるか判定 |
| 復旧 | 運用 | 誤投稿を削除（可能なら）。原因が設定なら temperament/channel_settings を直し config_version を rollback（§6.1）。原因が後段フィルタの穴なら [`../initial-data/prompts/journal-and-report.md`](../initial-data/prompts/journal-and-report.md) のガードを強化 |
| 事後 | オーナー/プライバシーオーナー | 機微情報流出なら A-1 の労務/法務対応。再発防止をガード/フィルタに反映。dryrun に落として再検証（§6.5） |

- 機微情報流出は [`../dogfooding/plan.md`](../dogfooding/plan.md) の「切る基準」に直結。1件でも即 off + 本インシデント。

## タイプ2: 記憶汚染（memory poisoning）

日記・本棚・索引カードに誤った/悪意ある情報が入り込み、以降の判断を歪める。§3.3（日記書き込みは夜間バッチ専用）・§12-3（untrusted）・§12-5（来歴）で予防している前提の、それでも起きた場合の対応。

| 段階 | 誰が | 何をする |
|---|---|---|
| 検知 | 個体自身/住人/運用 | memory_conflict Finding（[`../initial-data/finding-dictionary.md`](../initial-data/finding-dictionary.md)）、または住人の「その情報おかしい」指摘 |
| 封じ込め | 運用 | 該当個体を dryrun/off に落とす（汚染記憶を根拠に喋らせない）。汚染源が装備なら該当装備を回収（issuances 削除, §9.2） |
| 汚染追跡 | 運用 | **記憶の来歴で追跡**（§12-5）。夜間バッチが日記に残した「どのイベント由来か」を辿り、汚染エントリと、それを参照して育った本棚/playbook を特定 |
| 復旧 | 運用 | 汚染した books/journal を archive（削除ではなく status 変更, §3.4 の思想）。索引カードの誤リンクを外す。汚染前の config_version が絡むなら rollback |
| 事後 | 運用/オーナー | 汚染経路を塞ぐ: untrusted テキストが特権に流れていないか（§12-3）、日中書き込み経路が開いていないか（§3.3）を点検。来歴の粒度が足りなければ強化 |

- **untrusted 由来テキストを根拠にした自動起票・特権発火は禁止**（§6.4・§12-3）。汚染の主経路なので、ここが破られていないかを最優先で確認する。
- 個体間ではメモリを共有しない（§8.4）ので、汚染は原則1個体に閉じる。ディスカッション機能（P4）導入時は相手個体発言も untrusted 扱いで感染を遮断（§8.4）。

## タイプ3: 暴走（ループ・過剰アクション・コスト急騰）

| 段階 | 誰が | 何をする |
|---|---|---|
| 検知 | 運用/自動 | outbound 多層上限（§12-8）超過、使用量台帳アラート（[`cost-budget.md`](./cost-budget.md)）、platform_bug の連発（[`../initial-data/finding-dictionary.md`](../initial-data/finding-dictionary.md)） |
| 封じ込め | 発見者 | **全体キルスイッチ**（`/russell stop --all`、効かなければ env フラグ, [`kill-switch.md`](./kill-switch.md)）。DB 障害が絡むなら fail-closed で送信は自動停止しているはず（§12-7） |
| 影響特定 | 運用 | event_log でループの起点を特定（どの routine/finding が回っているか）。self-issue の暴発なら circuit breaker が効いているか確認（§6.4） |
| 復旧 | 運用 | 暴走している routine/finding を disable。原因の config_version を rollback。上限値（daily_speak_cap・件数上限・並列度）を見直す |
| 事後 | オーナー | circuit breaker / outbound 上限のしきい値を調整。バッチが対話予算を食い潰していたなら並列度分離を点検（§2） |

- 復旧直後の catch-up で溜まった実行が再暴走しないよう、catch-up policy=coalesce を確認（§5.1）。

## 事後レビュー（全タイプ共通）

- 時系列・原因・影響・対応・再発防止を `#russell-管理` にまとめる（軽量ポストモーテム）。
- 再発防止は「プロンプトで気をつける」ではなく**決定論的ゲート/上限/ガードの強化**に落とす（§12 プロンプトガードレールの欺瞞）。
- 報告のきっかけをくれた住人がいれば感謝を返す（§6.4 の思想を運用にも）。

> [!TODO] 記憶汚染時の「削除依頼」対応との整合 — 承認者: プライバシーオーナー。A-1 の「忘れて」削除範囲（本棚だけか日記も遡るか）と、汚染記憶の archive 方針を一本化する。

関連: [`kill-switch.md`](./kill-switch.md) / [`ownership-and-approval.md`](./ownership-and-approval.md) / [`cost-budget.md`](./cost-budget.md) / [`../initial-data/finding-dictionary.md`](../initial-data/finding-dictionary.md)
