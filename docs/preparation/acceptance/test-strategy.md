# 受け入れ基準書（test-strategy）（A-2）

> このドキュメントは準備チェックリスト [`A-2 受け入れ基準書`](../../design/preparation-checklist.md#a-2-受け入れ基準書test-strategy相当) を満たすためのテンプレートです。Frank v2 の `docs/test-strategy.md` に相当する、外注の納品判定の正本です。
>
> 関連: 設計書 [`§13 実装フェーズ`](../../design/human-like-agent-design.md) / 姉妹文書 [`equipment-conformance-suite.md`](./equipment-conformance-suite.md)・[`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md)・[`humanness-eval.md`](./humanness-eval.md) / [`../governance/scope-and-contract.md`](../governance/scope-and-contract.md)

---

## 0. 方針

設計書 §13 の「検証ポイント」は定性的な問い（「メモの取り方が自然か」等）である。これを **機械判定可能なバー**に翻訳し、フェーズ検収の合否をこれで決める。数値はすべて **提案値（ドラフト）** であり、`[!TODO]` で確定する。

- 測定は本番同等環境（ドッグフーディング用チャンネル）で、指定期間・指定件数で行う。
- レイテンシは p50/p95 を分ける。平均ではなく **p95** を合格判定に使う（テールが同僚体験を決める）。
- 主観評価（人間らしさ・うざさ）は [`humanness-eval.md`](./humanness-eval.md) の手順に委ね、本書では「その手順を実施し閾値を満たすこと」を条件として参照する。

---

## 1. P0: 会話とメモ帳

§13 検証ポイント: 応答品質、メモの取り方が自然か。

| # | 基準 | 測定方法 | 提案バー |
|---|---|---|---|
| P0-1 | mention 応答レイテンシ p95 | mention 受信 → 最初の応答（スレッド投稿 or typing 後の初回トークン）までの時間を N=100 会話で計測 | p95 ≤ 8 秒 / p50 ≤ 4 秒 |
| P0-2 | 応答成功率 | mention に対しエラーで無応答／例外にならず応答が返る割合 | ≥ 99% |
| P0-3 | メモ取得の妥当性 | 「メモして」等でメモが必要な会話 N 件のうち、`note.write` が発火し内容が妥当な割合（人手評価） | ≥ 90% |
| P0-4 | 過剰メモ率 | メモ不要な会話でメモを取ってしまう割合（false positive） | ≤ 10% |
| P0-5 | 手動 shelf.add | 「覚えておいて」で `shelf.add` が発火し本棚に載る | 100%（機能テスト） |
| P0-6 | temperament 反映 | temperament の tone 変更が人格プロンプトに反映される（config_version pin 込み） | 機能テスト合格 |

- [ ] P0 バー数値の確定
- [ ] 測定用会話コーパス（N=100）の準備

> [!TODO]
> **P0 の閾値（レイテンシ p95、成功率、メモ妥当性）の確定。決定オーナー: 発注側技術責任者。** 特にレイテンシは使用モデル（Sonnet）とインフラ（Cloud Run min-instances=1）に依存するため、実測ベースラインを取ってから確定する。

---

## 2. P1: 睡眠と日記

§13 検証ポイント: 翌日「昨日の件」が通じるか、日報が読まれるか。

| # | 基準 | 測定方法 | 提案バー |
|---|---|---|---|
| P1-1 | 「昨日の件」想起テスト正答率 | 前日の出来事に関する抜き打ち質問セット（[`humanness-eval.md`](./humanness-eval.md) のプロトコル）への正答率 | ≥ 85% |
| P1-2 | 夜間バッチ冪等性 | 同一日付キーで再実行しても journal が重複せず結果が一致（§4「日付キーで再実行可能」） | 100%（自動テスト） |
| P1-3 | 忘却曲線適用 | 減衰式が全 book に適用され、`strength < 0.2` が archived になる。重要ピンは strength ≥ 0.8 維持（§3.4） | 機能テスト合格 |
| P1-4 | deep_recall 到達率 | 会話読み出し（active）でヒットしない過去事項が `deep_recall` で見つかる割合 | ≥ 80% |
| P1-5 | 日報の機微情報ガード | [`../governance/sensitive-info-guard.md`](../governance/sensitive-info-guard.md) のコーパスに対する検知漏れ率 | コーパス上 検知漏れ 0 件（要確定） |
| P1-6 | 日報の可読性・有用性 | 週次アンケート「日報が読まれる／役立つ」スコア（[`humanness-eval.md`](./humanness-eval.md)） | 閾値は humanness-eval に準拠 |
| P1-7 | 完全性契約 | Slack 取得失敗時に「一部見られていない」と申告し、動きなしと誤報しない（§6.3） | 機能テスト合格 |

- [ ] P1 バー数値の確定（特に P1-1 の正答率）
- [ ] 想起テスト用の質問生成手順（[`humanness-eval.md`](./humanness-eval.md)）の準備
- [ ] 前提: A-1 合意済み（[`../governance/privacy-and-memory-policy.md`](../governance/privacy-and-memory-policy.md)）

> [!TODO]
> **P1-1 の想起テスト正答率目標の確定。決定オーナー: 発注側技術責任者 + ドッグフーディング推進者。** 「昨日の件が通じる」は Russell の中核価値であり、ここを緩くすると人間らしさ評価（残課題2）が空洞化する。85% は叩き台。P1-5 の検知漏れ許容も [`../governance/sensitive-info-guard.md`](../governance/sensitive-info-guard.md) と同期して確定する。

---

## 3. P2: 習慣

§13 検証ポイント: 朝の投稿が邪魔でないか。

| # | 基準 | 測定方法 | 提案バー |
|---|---|---|---|
| P2-1 | ルーティン実行の正確性 | 3種のルーティンが cron 期限に dispatcher で claim・実行される（§5.1） | 機能テスト合格 |
| P2-2 | catch-up 非連投 | サーバー停止後の再開で朝の挨拶が連投されない（既定 coalesce） | 停止→再開シナリオで 1 投稿のみ |
| P2-3 | 二重投稿ゼロ | lease/fencing/一意制約により論理実行が1件（§5.1） | 負荷・障害注入テストで 0 件 |
| P2-4 | 朝投稿の非邪魔性 | 週次アンケート「朝の投稿は邪魔か」の否定回答率／ミュート・オプトアウト申請数 | 「邪魔」回答 ≤ 20%、オプトアウト ≤ 1件/週（要確定） |
| P2-5 | succeeded_zero の正当性 | 「報告事項ゼロ」を名乗るのは全ソース complete のときだけ（§5.1・§6.3） | 機能テスト合格 |
| P2-6 | 本棚 Web UI | `/shelf` で棚・強度・読書カード・書き込みが読み取り専用で見える（§10.1） | 機能テスト合格 |

- [ ] P2 バー数値の確定（特に P2-4 の非邪魔性指標）
- [ ] catch-up・二重投稿の障害注入テスト手順の準備

> [!TODO]
> **P2-4「朝投稿の非邪魔性」の測り方と閾値の確定。決定オーナー: ドッグフーディング推進者。** アンケート項目（[`humanness-eval.md`](./humanness-eval.md)）とオプトアウト・ミュート数のどちらを主指標にするか、その閾値を決める。

---

## 4. P3: 気づきと成長

§13 検証ポイント: dryrun の Finding 精度、live 後のうざさ ↔ 有能さ。P3 は proactivity を 0.3 から始め週次で上げる。

| # | 基準 | 測定方法 | 提案バー |
|---|---|---|---|
| P3-1 | dryrun Finding 精度（人間レビュー妥当率） | dryrun 出力の Finding を人間がレビューし「妥当（言う価値がある）」と判定する割合（[`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md)） | ≥ 70% |
| P3-2 | 誤検知率 | 明らかに不要・的外れな Finding の割合 | ≤ 15% |
| P3-3 | dedup 有効性 | 同一 finding_key で二度言わない（§6.2） | 重複通知 0 件 |
| P3-4 | 根拠の追跡可能性 | 各 Finding が facts + evidence（Slack permalink 等）+ config_version を持ち「なぜそう思ったか」に答えられる（§6.2） | 100%（構造テスト） |
| P3-5 | untrusted の無害化 | Slack メッセージ内の指示を気づきトリガーにしない・特権ツールに流さない（§6・§12） | インジェクション試験で 0 件発火 |
| P3-6 | 遠慮レートリミッタ | 自発発言が daily_speak_cap 内・同一スレッド再介入なし・静音時間は翌朝送り（§6） | 機能テスト合格 |
| P3-7 | live 後のうざさ ↔ 有能さ | 週次アンケートの「同僚感」「うざさ」スコア（[`humanness-eval.md`](./humanness-eval.md)） | 閾値は humanness-eval に準拠 |
| P3-8 | 学習習慣の HITL | 検出した繰り返しを勝手に習慣化せず提案→承認で routines に追加（§5・origin='learned'） | 機能テスト合格 |
| P3-9 | セルフイシュー健全性 | platform_bug の dedup・PII 除外・件数上限（例 3件/週）・circuit breaker（§6.4） | 機能テスト合格 |

- [ ] P3 バー数値の確定（特に P3-1 妥当率）
- [ ] dryrun→live 昇格手順（[`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md)）との整合確認
- [ ] インジェクション試験ケースの準備

> [!TODO]
> **P3-1 の dryrun Finding 妥当率合格ラインの確定。決定オーナー: 発注側技術責任者 + ドッグフーディング推進者。** この値は [`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md) の昇格判定と同一値にする（二重管理を避ける）。70% は叩き台。live 昇格に必要なレビュー日数・レビュアーもそちらで確定。

---

## 5. 全フェーズ横断の必須ゲート

フェーズに関わらず、以下は納品の前提条件（合格しなければフェーズ検収に進めない）。

- [ ] 全装備／プラグインが [`equipment-conformance-suite.md`](./equipment-conformance-suite.md) を通過
- [ ] Policy Gate: 未許可・未分類・未知リソースが default-deny（§9.2・§12）
- [ ] fail-closed: ポリシー／承認記録／キルスイッチが読めないとき外部送信・書き込みをしない（§12-7）
- [ ] キルスイッチ: `/russell stop` + env フラグで全自発行動を即凍結、DB 障害時も別経路で効く（§12-4/-7）
- [ ] 監査ログ: 全アクションが event_log に trust_label 付きで残る（§3.1・§12）
- [ ] マイグレーション: 起動時 CREATE TABLE をせず expand→backfill→contract（§11）
