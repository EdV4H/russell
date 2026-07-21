# 装備／プラグイン共通 conformance suite（A-2）

> このドキュメントは準備チェックリスト [`A-2`](../../design/preparation-checklist.md#a-2-受け入れ基準書test-strategy相当) の「装備 conformance suite 仕様」を満たすためのテンプレートです。[`plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md) に従い、**全プラグイン（装備 / surface / memory / finding / …）が満たすべき共通契約テスト**に一般化しています。
>
> 関連: 設計書 [`§9 Equipment`](../../design/human-like-agent-design.md)・[`§12 セキュリティ`](../../design/human-like-agent-design.md)・[`§6.3 完全性契約`](../../design/human-like-agent-design.md) / [`test-strategy.md`](./test-strategy.md)

---

## 0. 使い方

外注は **新しい装備／プラグインを納品するたびに、本 suite の全項目を当該プラグインで実行し、結果を提出する。** 1項目でも落ちるプラグインは支給（issuance）・register 対象にしない。設計書 §9.1「新しい装備の追加は台帳に登録するだけ・本体コード変更不要」の前提を守るには、コアが信頼できる共通契約が必要で、それが本 suite。

各項目は「対象プラグイン種別」を示す。装備（MCP 接続）は全項目、surface / memory 等は該当する項目のみ。

---

## 1. 権限エラー処理

外部システムが権限不足・認可失敗を返したときの振る舞い。

- [ ] スコープ外／権限不足の操作で例外落ちせず、構造化エラーを返す
- [ ] 権限エラーを「成功」や「空の結果」と誤認しない（§6.3 完全性契約: `unauthorized` を明示）
- [ ] 権限エラー時に自動で権限昇格・別トークン試行をしない
- [ ] エラーは event_log に記録される（§3.1）

## 2. timeout → OperationResult=unknown（blind retry 禁止）

設計書 §9.2 の中核契約。書き込みの「結果不明」を一級で扱う。

- [ ] 応答が timeout したとき、結果を `OperationResult=unknown` として返す（`succeeded` でも `failed` でもない）
- [ ] **unknown な書き込みを自動再試行（blind retry）しない**（二重投稿・重複作成の防止）
- [ ] idempotency key を付与して発行し、read-after-write で実結果を突き合わせて解決する
- [ ] unknown が頻発したらセルフイシュー（§6.4 platform_bug）の検知ソースになる
- [ ] read 系（`read` 効果分類）の timeout は安全に再試行してよい（副作用がないため）が、上限回数を持つ

## 3. preflight（実行前の実行時検査）

- [ ] write 系ツールは実行前に「このトークン・この対象で本当に書けるか」を検査する（§9.2）
- [ ] preflight 失敗時に本実行へ進まない
- [ ] preflight は副作用を持たない（dry な検査であること）

## 4. 効果分類の宣言と default-deny

- [ ] 各ツールが効果分類を宣言する: `read` / `internal_write` / `external_write` / `external_send` / `irreversible_write`（§9.2）
- [ ] **未分類ツール・未知リソースは default deny**（Policy Gate が実行を拒否）
- [ ] danger_level は効果分類から導出される（手動の食い違いがない）
- [ ] danger_level 2 以上は使用のたび HITL 承認を要する（§9.1）
- [ ] 効果分類の追加・変更は発注側承認事項（[`../governance/scope-and-contract.md`](../governance/scope-and-contract.md) の仕分け表）

## 5. 冪等性（idempotency）

- [ ] 同一 idempotency key での再実行が副作用を二重に起こさない
- [ ] リトライ・catch-up（§5.1）・at-least-once 配送下でも論理的に1回になる
- [ ] `(agent_id, routine_id, scheduled_for)` 等の一意制約に相当する重複防止を持つ（習慣系）

## 6. graceful degradation（手動案内への段階的縮退）

- [ ] 非対応・権限不足・外部障害時に機能全滅させず「手動操作の案内」へ縮退する（§9.2）
- [ ] 縮退したことを利用者に明示する（黙って何もしないをしない）
- [ ] 縮退状態が ExecutionRun に `degraded` として記録される（§5.1 の結果分類）

## 7. teardown の清潔さ

plugin-first 契約: teardown は `setup` の戻り値（[`plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）。

- [ ] `setup(ctx)` が teardown 関数を返す
- [ ] teardown で接続・購読・タイマー・一時リソースをすべて解放する（リークなし）
- [ ] 二重 `setup` / setup→teardown→setup で状態が壊れない
- [ ] teardown 後にコールバックが発火しない（幽霊購読なし）

## 8. killswitch の尊重

- [ ] キルスイッチ発動中（`/ryo stop` / env フラグ）は外部送信・書き込みを行わない（§12-4）
- [ ] 副作用の直前にモードとキルスイッチを再検査する（§5.1）
- [ ] DB 障害等でポリシー・承認・killswitch が読めないときは実行しない側（fail-closed）に倒れる（§12-7）
- [ ] killswitch は DB 非依存の別経路（env / プロセスシグナル）でも効く

## 9. 信頼ラベルの伝播（該当プラグイン）

- [ ] 外部由来テキスト（他人の発言・URL 先・他個体の発言）を `untrusted` としてラベルする（§12-3・§8.4）
- [ ] untrusted 変数が特権ツール引数に入ったらブロックされる
- [ ] untrusted 内の指示（「〜を実行して」）をトリガー・コマンドとして解釈しない（§6 間接プロンプトインジェクション対策）

## 10. 完全性の申告（該当プラグイン: 取得系）

- [ ] 取得結果を `SourceResult(status: complete / partial / failed / unauthorized, freshness)` で返す（§6.3）
- [ ] partial / failed / unauthorized のソースに依存する導出は unknown に落とすか導出しない
- [ ] `complete` のときだけ「動きなし／報告事項ゼロ」を名乗れる

## 11. 監査・観測

- [ ] 全ツール呼び出しが event_log と OpenTelemetry トレースに乗る（§11）
- [ ] LLM / API / 送信の使用量が個体付きで使用量イベント台帳に記録される（§11）

---

## 提出フォーマット

各プラグインの conformance 結果は、上記チェックリストに「合格 / 不合格 / 非該当（理由）」を付して提出する。不合格・非該当は必ず理由を書く。

> [!TODO]
> **本 suite の項目の過不足レビューと、装備別の必須／非該当マッピングの確定。決定オーナー: 発注側技術責任者。** 特に `terminal`（danger_level 3、§9.2）に対する追加項目（サンドボックス VM 限定・全コマンド event_log・破壊系 HITL 必須）を装備固有の補遺として足すか判断する。また各項目の自動テスト化の範囲（どこまで CI で回すか）を決める。
