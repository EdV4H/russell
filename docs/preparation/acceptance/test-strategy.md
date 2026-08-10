# 受け入れ基準書（test-strategy）（A-2）

> このドキュメントは準備チェックリスト [`A-2 受け入れ基準書`](../../design/preparation-checklist.md#a-2-受け入れ基準書test-strategy相当) を満たすためのテンプレートです。Frank v2 の `docs/test-strategy.md` に相当する、外注の納品判定の正本です。
>
> 関連: 設計書 [`§13 実装フェーズ`](../../design/human-like-agent-design.md) / 姉妹文書 [`equipment-conformance-suite.md`](./equipment-conformance-suite.md)・[`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md)・[`humanness-eval.md`](./humanness-eval.md) / [`../governance/scope-and-contract.md`](../governance/scope-and-contract.md)

---

## 0. 方針

設計書 §13 の「検証ポイント」は定性的な問い（「メモの取り方が自然か」等）である。これを **機械判定可能なバー**に翻訳し、フェーズ検収の合否をこれで決める。

> [!IMPORTANT]
> **決定（2026-07-22）: 下表の各バーを「v1 採用バー」として確定する。** 外注への納品判定はこの数値で行う。ただし2種類だけ扱いが違う:
> - **実測依存（latency 等）**: 使用モデル・インフラに依存する値は、ドッグフーディング開始後の実測でベースラインを取り、**乖離が大きければ再調整**する（値そのものは v1 を初期契約値とする）。
> - **A-1 連動（P1-5 機微ガード検知漏れ）**: [`../governance/sensitive-info-guard.md`](../governance/sensitive-info-guard.md) の目標値（A1-6）と同一にする。
>
> 残るのは**レビュアー／測定オーナーの指名**（人間）と、上記2種の**実測後サインオフ**だけ。純粋な機能テスト（合否が二値）は即確定。

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

- [x] P0 バー数値を v1 採用（p95≤8s/p50≤4s・成功率≥99%・メモ妥当性≥90%・過剰メモ≤10%）
- [ ] 測定用会話コーパス（N=100）の準備
- [ ] レイテンシの実測ベースライン取得 → 乖離時に再調整（Sonnet 5 / Cloud Run min-instances=1 依存）

> [!NOTE]
> P0 バーは v1 採用済み。残るのは実測ベースライン（latency）とコーパス準備のみ。機能テスト（P0-5/6）は二値で即判定。

> [!IMPORTANT] **決定（2026-08-10）**
> P0-3/P0-4/P0-5 の**判定主体が変わった**。記憶するかどうかは正規表現ではなくモデルが決める
> （[ADR 0003](../../adr/0003-model-decides-what-to-remember.md)）。読み替えは2点:
> - P0-5 は「正規表現が一致すること」ではなく「**発火すること**」で読む。明示された依頼は必ず書き留める、が判定の指示に入っている
> - P0-3/P0-4 は**言われなくても書く**ようになったので、正規表現の頃の数字と比較できない。実測を取り直す
>   （コーパスには「明示されないが記憶すべき会話」と「明示的に断られた会話」を含める）

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

- [x] P1 バー数値を v1 採用（想起正答率 **≥85%**・deep_recall到達 ≥80%・冪等/忘却/完全性は機能テスト）
- [ ] 想起テスト用の質問生成手順（[`humanness-eval.md`](./humanness-eval.md)）の準備
- [ ] P1-5 検知漏れ目標を A1-6（[`sensitive-info-guard`](../governance/sensitive-info-guard.md)）と同値に確定
- [ ] 前提: A-1 合意済み（[`../governance/privacy-and-memory-policy.md`](../governance/privacy-and-memory-policy.md)）

> [!NOTE]
> P1-1 想起正答率は v1=**85%** を採用（中核価値のため緩めない方針）。実測で難易度が判明したら再調整。P1-5 は A1-6 の目標数値に追従。

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

- [x] P2 バー数値を v1 採用（「邪魔」回答 ≤20%・オプトアウト ≤1件/週・catch-up/二重投稿は機能&障害注入で二値）
- [ ] catch-up・二重投稿の障害注入テスト手順の準備

> [!NOTE]
> P2-4 非邪魔性は v1=「邪魔」回答≤20%（主指標=アンケート、副=オプトアウト数）を採用。ドッグフーディング推進者が実測後に微調整。

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

- [x] P3 バー数値を v1 採用（dryrun妥当率 **≥70%**・誤検知 ≤15%・dedup/追跡/injection/レートリミッタ/HITL/セルフイシューは機能テスト）
- [ ] dryrun→live 昇格手順（[`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md)）との整合確認
- [ ] インジェクション試験ケースの準備

> [!NOTE]
> P3-1 妥当率は v1=**70%** を採用。この値は [`dryrun-to-live-promotion.md`](./dryrun-to-live-promotion.md) の昇格判定と同一（二重管理回避）。レビュー日数・レビュアーはそちらで確定。

---

> [!NOTE]
> **DB を使うテストは専用 DB（`<db>_test`）で走る。** 開発用 DB と共有していると、テストが作った
> 個体（`ks-…` `resil-…`）で本物の記憶が埋もれる（ビューアを入れて発覚）。`globalSetup` が
> 毎回作り直すので前回の残骸も消える。終了後は消さない——落ちたときに中を見られる方がよいので。

## 5. 全フェーズ横断の必須ゲート

フェーズに関わらず、以下は納品の前提条件（合格しなければフェーズ検収に進めない）。

- [ ] 全装備／プラグインが [`equipment-conformance-suite.md`](./equipment-conformance-suite.md) を通過
- [x] Policy Gate: 未許可・未分類・未知リソースが default-deny（§9.2・§12） — `apps/agent/test/audit.test.ts`（`policy.denied` / `effect_undeclared`）
- [x] fail-closed: ポリシー／承認記録／キルスイッチが読めないとき外部送信・書き込みをしない（§12-7） — 監査 sink 全滅時に `read` 以外を deny し応答送信も止める（同テスト）
- [x] キルスイッチ: `/russell stop` + env フラグで全自発行動を即凍結、DB 障害時も別経路で効く（§12-4/-7） — 契約は [`../../reference/35-killswitch.md`](../../reference/35-killswitch.md)。`killswitch.test.ts` / `killswitch-command.test.ts` / `killswitch-pg.test.ts`
- [x] 監査ログ: 全アクションが event_log に trust_label 付きで残る（§3.1・§12） — コアが記録・`@edv4h/russell-plugin-audit-pg` が追記専用で永続化。`audit.test.ts` / `audit-pg.test.ts`
- [x] マイグレーション: 起動時 CREATE TABLE をせず expand→backfill→contract（§11） — `@edv4h/russell-migrate`（台帳 `schema_migrations`・`pnpm migrate`）。契約は [`../../reference/34-migrations.md`](../../reference/34-migrations.md)。`migrate.test.ts` / `migrate.offline.test.ts`

> [!NOTE]
> 監査ログの検証内容: 受信→ツール→モデル→送信の全アクションが `trust_label` 付きで残る／untrusted 起因の
> ツール実行は untrusted のまま残る（§12-3）／payload に本文を入れない（A1-5）／`event_log` の UPDATE・DELETE を
> DB 側のトリガで拒否（追記専用）。装備プラグイン追加時は conformance suite 側で同じ観点を再確認する。

> [!NOTE]
> キルスイッチの検証内容: 凍結中（レベル1/2）は mention に固定文だけ返し、モデルもツールも動かさない／
> 凍結状態が**読めない**ときは完全沈黙（fail-closed）／ターンの途中で発動されたら送信の直前で止まる（§5.1）／
> 凍結中の Policy Gate が `stopped` で拒否する／env（レベル3）が最優先で、**DB を1度も読まない**
> （＝DB 障害時にも効く別経路, §12-7）／`/russell stop` が**プロセスを跨いで**効く／
> 監査が壊れていても**止まれる**が**解除はできない**／曖昧な引数は「自分を止める」に倒れる／
> DB 接続を外から切られても**プロセスが落ちず**、再接続して応答に戻る（`pg-resilience.test.ts`）。

> [!NOTE]
> マイグレーションの検証内容: 未適用の DB ではエージェントが**起動しない**（起動経路が DDL を流さない）／
> 適用は冪等で、同時実行しても advisory lock で二重適用しない／適用済み SQL の改変を checksum で検出して止める／
> expand→backfill→contract が3段で回り、**既定では contract を流さない**（旧列が残ったまま新列を読める）／
> `autoMigrate` は `NODE_ENV=production` で拒否される。
