# スコープと契約の定義（A-3）

> このドキュメントは準備チェックリスト [`A-3 スコープと契約の定義`](../../design/preparation-checklist.md#a-3-スコープと契約の定義) を満たすためのテンプレートです。
>
> 関連: 設計書 [`§13 実装フェーズ`](../../design/human-like-agent-design.md) / [`plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md) / 受け入れ基準 [`../acceptance/test-strategy.md`](../acceptance/test-strategy.md)

---

## 1. 段階発注 vs 一括発注

設計書 §13 は実装を P0〜P3 のフェーズに分けている。発注形態はこのフェーズ境界を発注単位に使える。

### 提案デフォルト（ドラフト）

**段階発注（フェーズごと）を推奨。** 理由:

- 各フェーズに機械判定可能な完了定義がある（[`../acceptance/test-strategy.md`](../acceptance/test-strategy.md)）ため、フェーズ単位で検収・支払いを切れる。
- P0/P1 の品質を見てから P3（気づき・自発性）の発注可否を判断できる。P3 は「うざさ ↔ 有能さ」の主観評価を含み最もリスクが高い。
- A-1（社内合意）の結論が P1 以降の設計を変えうる（全公開→限定公開）。一括で縛ると手戻りコストが大きい。

一括発注が有利なのは、同一チームを通期で確保でき、フェーズ間のコンテキスト引き継ぎコストを避けたい場合。

### フェーズ発注単位（§13 の表を発注単位に変換）

| 発注単位 | 対応フェーズ | 主なスコープ | 検収の入口 |
|---|---|---|---|
| 発注1 | P0: 会話とメモ帳 | surface(Slack) + Agent Core + notes + 手動 shelf.add + temperament 骨格 | test-strategy P0 バー |
| 発注2 | P1: 睡眠と日記 | 夜間バッチ・journal・忘却曲線・deep_recall・日報投稿 | test-strategy P1 バー + A-1 合意済み |
| 発注3 | P2: 習慣 | ビルトインルーティン3種・本棚 Web UI | test-strategy P2 バー |
| 発注4 | P3: 気づきと成長 | Finding モデル・気づき・playbook・学習習慣・channel_settings・dryrun→live | test-strategy P3 バー + dryrun→live 昇格手順 |

> [!TODO]
> **発注形態（段階 / 一括）の確定。決定オーナー: 発注責任者。** 段階発注の場合、各発注の検収と次発注の Go/No-Go 判断者を明記する。P0/P1 の結果次第で P3 を発注しない選択肢を契約に残すか（オプション契約）も決める。

---

## 2. plugin-first を踏まえた発注境界（どのプラグインを外注し、どこを内製するか）

[`plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md) により、Ryo は **極小コア + プラグイン**で構成される。発注境界はプラグイン境界で切れる。

### 原則（ドラフト）

- **コア・policy は内製（発注側が持つ）。** セキュリティをプラグインに委ねない（plugin-first ノート「コアに残すもの」）。具体的には認知ループ・レジストリ／ライフサイクル・**Policy Gate の決定論的原値**（allowlist 判定枠組み・fail-closed・キルスイッチ別経路）。
- **surface / equipment は外注可能。** 通信面（`surface-slack` ほか）・装備（`equipment-*`）は契約が明確（[`../acceptance/equipment-conformance-suite.md`](../acceptance/equipment-conformance-suite.md) の共通テストを満たせばよい）ため外注に向く。
- **memory / finding / routine / model プラグインは要判断。** 記憶（`memory-pg`）は PII と retention に直結（[`privacy-and-memory-policy.md`](./privacy-and-memory-policy.md)）するため、少なくともスキーマとガードは発注側承認事項。

| 構成要素 | 提案: 内製 / 外注 | 理由 |
|---|---|---|
| コア（認知ループ・レジストリ・ライフサイクル） | 内製 | ロックインを避けるべき本体 |
| `policy`（Policy Gate 原値・効果分類の枠組み） | 内製 | セキュリティ境界。委譲しない |
| `surface-slack` ほか通信面 | 外注可 | 契約明確・差し替え可能 |
| `equipment-*`（装備 = MCP 接続） | 外注可 | conformance suite で受け入れ判定 |
| `memory-pg`（記憶実装） | 外注可・ただしスキーマ/ガードは承認要 | PII・retention に直結 |
| `finding-*`（気づき種別） | 外注可・ただし kind/reason_code 辞書は承認要 | 効果分類・自発性に直結 |
| `routine-*` / `habit-*`（習慣） | 外注可 | prompt 本文は承認要（下表） |
| `model-claude`（モデル選択） | 外注可 | |

> [!TODO]
> **プラグイン単位の内製／外注の最終割り当て。決定オーナー: 発注責任者 + 技術責任者。** 特に `memory-pg` と `finding-*`・`policy` を外注に含めるかを確定する。コアと policy を内製にできる社内リソースがあるかの確認を含む。

---

## 3. 各フェーズ完了定義（§13 の検証ポイントを完了定義へ）

機械判定可能な数値バーは [`../acceptance/test-strategy.md`](../acceptance/test-strategy.md) に集約する。ここでは「そのフェーズが終わったと言える機能的条件」を定義する。

- **P0 完了**: Slack で mention すると Agent Core が応答し、`note.write` と手動 `shelf.add` が動く。temperament 骨格から人格プロンプトが生成される。→ test-strategy P0 バー通過。
- **P1 完了**: 夜間バッチが冪等に日記を書き、忘却曲線が適用され、`deep_recall` が使え、日報が投稿される。「昨日の件」が翌日通じる。→ test-strategy P1 バー通過 + A-1 合意済み + [`sensitive-info-guard.md`](./sensitive-info-guard.md) のガード合格。
- **P2 完了**: ビルトイン習慣3種が dispatcher（§5.1）で動き、catch-up policy が効き、本棚 Web UI が読める。→ test-strategy P2 バー通過。
- **P3 完了**: Finding モデル・気づきモジュール・playbook・学習習慣が動き、dryrun 並走 → 人間レビュー → live 昇格（§6.5）が [`../acceptance/dryrun-to-live-promotion.md`](../acceptance/dryrun-to-live-promotion.md) の手順で成立する。→ test-strategy P3 バー通過。

- [ ] 各フェーズ完了定義の承認（上記で過不足ないか）
- [ ] 完了定義と検収・支払いの紐付けの確定

---

## 4. 実装者裁量 vs 発注側承認の仕分け

「実装者が決めてよいこと」と「発注側承認が要ること」を明示する。設計書のパラメータや方針のうち、値の選び方が事業・セキュリティ・労務に影響するものは承認事項。

| 項目 | 区分 | 根拠 |
|---|---|---|
| 忘却率 λ の初期値・チューニング | 実装者に任せる | §3.4・§8.1。挙動パラメータで可逆 |
| ベクトル検索のランキング係数・token 予算の内訳 | 実装者に任せる | §3.2。性能最適化の範囲 |
| プラグイン内部の実装（アルゴリズム・ライブラリ選定） | 実装者に任せる | plugin-first。契約さえ満たせばよい |
| dispatcher の tick 間隔・lease 長 | 実装者に任せる | §5.1。運用で調整可能 |
| プレイブックの confidence 初期値・成長式 | 実装者に任せる | §7 |
| **効果分類（effect-class）の追加・変更** | **発注側承認要** | §9.2・§12。セキュリティ境界 |
| **`policy/`（Policy Gate）の判定ロジック・fail-closed 挙動** | **発注側承認要** | §12・plugin-first「コアに残す」 |
| **装備スコープ・danger_level・支給内容** | **発注側承認要** | §9。権限境界 |
| **人格・日記・日報・読書カードの生成プロンプト** | **発注側承認要** | §10.1・機微情報ガード |
| **Finding kind / reason_code の追加** | **発注側承認要** | §6.2。自発性・通知に直結 |
| **temperament の確定値・proactivity 初期値** | **発注側承認要** | §6.1・§13（P3 は 0.3 から） |
| **retention・削除範囲・opt-in 方針** | **発注側承認要** | [`privacy-and-memory-policy.md`](./privacy-and-memory-policy.md) |
| **機微情報 DO-NOT-WRITE リスト** | **発注側承認要** | [`sensitive-info-guard.md`](./sensitive-info-guard.md) |
| **キルスイッチ・HITL 要否の閾値の決定論的下限** | **発注側承認要** | §9.3・§12 |

> [!TODO]
> **仕分け表の最終確認と、承認が必要な項目の承認者の割り当て。決定オーナー: 発注責任者 + 技術責任者。** 表の各「承認要」行について、承認者（人事／法務／技術責任者のいずれか）を明記する。プロンプトと effect-class の変更が発注側承認を通らずマージされない運用（下記コードレビュー体制）を担保すること。

---

## 5. コードレビュー体制

設計書 A-3 の「外注任せにしない箇所 = policy/・装備スコープ・プロンプト」を、レビュー必須の変更として制度化する。

### 提案デフォルト（ドラフト）

- すべての PR は最低1名のレビュー承認を要する（main への直 push 禁止）。
- 次のパスに触れる PR は **発注側レビュアーの承認を必須**（外注レビューだけでは通さない）:
  - `policy/`（Policy Gate・効果分類・fail-closed・キルスイッチ）
  - 装備台帳・スコープ・danger_level 定義
  - 生成プロンプト（人格・日記・日報・読書カード・ガード）
  - retention・削除・opt-in に関わる記憶実装
  - Finding kind / reason_code 辞書
- 上記以外（プラグイン内部実装・挙動パラメータ）は外注内レビューで可。
- セキュリティ観点のレビューは §12 のガードレール（信頼ラベル伝播・untrusted の特権ツール流入禁止）をチェックリスト化して適用する。

### チェックリスト

- [ ] main 保護・PR 必須レビューの設定（[`../infra/setup-checklist.md`](../infra/setup-checklist.md) の CI 方針と連動）
- [ ] 発注側レビュー必須パスの CODEOWNERS 等での強制
- [ ] セキュリティレビュー・チェックリストの整備

> [!TODO]
> **コードレビュー体制の確定と発注側レビュアーのアサイン。決定オーナー: 技術責任者。** 誰が発注側レビュアーか（氏名）、レビュー SLA（何営業日以内に見るか）、レビュアー不在時のエスカレーション先を確定する。CODEOWNERS で「承認要」パスを機械的に強制する構成を推奨。
