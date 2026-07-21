# Finding kind / reason_code 初期辞書

> [!NOTE]
> 準備物 B-1。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §6.2（Findingモデル）・§6.4（セルフイシュー）・§9（効果分類）が源泉。
> plugin-first（[`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）では各 kind は `finding-*` プラグイン（`ryo-plugin-finding-{kind}`）として `findings` レジストリに register される検知器。この辞書はその初期セットの契約。

## Finding の骨格（§6.2 再掲）

気づきは揮発イベントではなく永続レコード。各 kind は次を持つ。

- `finding_key` — `kind` + 主体 + 理由から決定的に生成する dedup / 新旧比較の恒等キー。**同じことを二度言わない。**
- `reason_code` — 判定理由の機械可読コード。
- `facts` — 導出に使った事実（値 + 取得元 + 取得時刻）。「なぜそう思ったの」に答えられる。
- `evidence` — 根拠へのソース参照（Slack permalink 等）。
- `proposed_action` — 提案アクション。これに対応する実行の**効果分類**（§9）で危険度が決まる。
- `state` — `detected / notified / acknowledged / resolved / suppressed`。

> [!IMPORTANT]
> 全 kind は §6.5 の3モードを標準装備し **dryrun-first**（`off → dryrun → live`）。dryrun 中は Finding 導出と文面生成まで行い、投稿はログと管理チャンネルのみ（live の dedup 状態を汚さない）。live 昇格は「dryrun 出力を人間が N 日分レビューして承認」を通す（[`../operations/ownership-and-approval.md`](../operations/ownership-and-approval.md)）。

## 効果分類の凡例（§9）

| 効果分類 | 意味 | 既定の関門 |
|---|---|---|
| `read` | 読むだけ | なし |
| `internal_write` | 記憶・DB 等内部書き込み | dryrun→live |
| `external_write` | 外部システムへの書き込み（Issue/ページ更新） | スコープ付き事前承認 or 毎回 HITL |
| `external_send` | 外部への送信（Slack 投稿・DM） | daily_speak_cap + 静音時間 + dryrun→live |
| `irreversible_write` | 不可逆（削除・破壊） | 毎回 HITL 必須 |

## 初期辞書

### deadline_risk — 締切リスク

| 項目 | 内容 |
|---|---|
| 定義 | 約束・タスク・依頼に紐づく締切が接近しているのに未完了/未着手に見える |
| reason_code 例 | `DUE_SOON_NO_PROGRESS` / `OVERDUE` / `NO_ASSIGNEE` |
| facts 例 | `{ "task": "週次レポート", "due": "2026-07-24", "last_activity": "2026-07-18", "source": "slack:C123/p169..", "fetched_at": "..." }` |
| evidence | 依頼発言の permalink、進捗が止まっているスレッド |
| proposed_action | 「そろそろ着手が必要そうです。私がドラフトを用意しましょうか？」と本人にリマインド |
| 結果アクションの効果分類 | `external_send`（Slack 投稿） |
| dryrun-first | ✅（番頭で高頻度に出るため、まず dryrun で誤検知率を見る） |

### doc_drift — ドキュメントの乖離

| 項目 | 内容 |
|---|---|
| 定義 | スレッドで決まった仕様/決定と、既存ドキュメント（Notion 等）の記述が食い違う |
| reason_code 例 | `SPEC_CONTRADICTION` / `DECISION_NOT_REFLECTED` / `STALE_DOC` |
| facts 例 | `{ "decision": "無料枠を5→3に", "doc": "notion:page/abc", "doc_says": "5", "fetched_at": "..." }` |
| evidence | 決定が下されたスレッドの permalink、対象ドキュメントの URL |
| proposed_action | 「先週の決定と食い違っていますが、どちらが正ですか？」→ 合意後にドキュメント更新 PR/ページ更新（HITL） |
| 結果アクションの効果分類 | `external_write`（Notion/docs 更新） |
| dryrun-first | ✅ |

### decision_detected — 意思決定の検知

| 項目 | 内容 |
|---|---|
| 定義 | スレッドで実質的な意思決定が下されたが、記録（決定事項の棚）に残っていない |
| reason_code 例 | `CONSENSUS_REACHED` / `OWNER_APPROVED` |
| facts 例 | `{ "decision": "リリースを金曜に延期", "participants": ["A","B"], "source": "slack:...", "fetched_at": "..." }` |
| evidence | 合意に至ったスレッドの permalink |
| proposed_action | 「これは決定事項として本棚に記録しておきますね」→ `shelf.add`。必要ならドキュメント反映を別途 doc_drift 経路へ |
| 結果アクションの効果分類 | `internal_write`（本棚追加）。ドキュメント反映は `external_write` |
| dryrun-first | ✅ |

### platform_bug — 自分の基盤の不具合（セルフイシュー §6.4）

| 項目 | 内容 |
|---|---|
| 定義 | 自分の実行基盤（SDK・装備・エンジン）の不調。**検知ソースは内部テレメトリのみ**（ExecutionRun の degraded/failed 反復、装備 `OperationResult=unknown/rejected` 頻発、Policy Gate 想定外ブロック、タスク自己評価） |
| reason_code 例 | `EQUIPMENT_UNKNOWN_RESULT_REPEATED` / `RUN_DEGRADED_REPEATED` / `POLICY_UNEXPECTED_BLOCK` |
| finding_key | **エラーシグネチャ（例外種別 + 発生箇所のハッシュ）から決定的生成**。同じ不具合で複数 Issue を立てない。再発は既存 Issue にコメント追記 |
| facts 例 | `{ "signature": "notion.write#timeout@a1b2", "count_7d": 4, "run_ids": ["r1","r2"], "config_version": "cv-2026-07-01" }` |
| evidence | 内部 run id への参照のみ（**会話生ログ・PII は書かない**。公開リポでも安全な内容に限定） |
| proposed_action | 症状/再現情報/頻度/影響/（可能なら）修正案を構造化して自リポジトリに Issue 起票 |
| 結果アクションの効果分類 | `external_write`（GitHub Issue） |
| dryrun-first | ✅ + **circuit breaker 対象**（起票機能自体の不具合で暴発させない）。untrusted 由来テキストを根拠にした自動起票は禁止（自動経路は内部テレメトリのみ）。スコープ付き事前承認（自リポのみ・件数上限 例3件/週） |

### user_feedback — 人間からのフィードバック（§6.4）

| 項目 | 内容 |
|---|---|
| 定義 | Slack 上で人間からもらった FB（「この通知うざい」「昨日の要約、数字間違ってた」）。**untrusted テキスト起点なので自動経路とは別扱い** |
| reason_code 例 | `FB_CONFIG`（①設定で直る）/ `FB_MEMORY`（②記憶の誤り）/ `FB_PLATFORM`（③基盤の問題） |
| トリアージ | 3分類必須。①→ temperament/channel_settings 変更提案として管理者へ ②→ 本棚・索引カード修正をその場で ③→ Issue 起票へ。**なんでも Issue にしない** |
| facts 例 | `{ "triage": "FB_PLATFORM", "run_ref": "r9", "fetched_at": "..." }` |
| evidence | FB 発言の Slack permalink（**原文転記はしない**。個体が構造化テンプレートに要約して起票し、原文は evidence 参照に留める＝指示混入の遮断） |
| proposed_action | **本人確認 HITL 必須**：「基盤の問題っぽいので Issue にします。この内容で合ってますか？」+ プレビュー + 承認ボタン → 起票。close 検知で報告者に感謝を返す |
| 結果アクションの効果分類 | `external_write`（GitHub Issue） |
| dryrun-first | ✅（③のみ。①②は Issue にしない） |

## 追加提案 kind（初期に入れておくと有用）

### stale_thread — 放置スレッド（番頭向け）

| 項目 | 内容 |
|---|---|
| 定義 | 自分/チームへの依頼・質問が一定時間 未返信で放置されている |
| reason_code 例 | `UNANSWERED_MENTION` / `QUESTION_NO_REPLY` |
| facts 例 | `{ "thread": "slack:...", "asked_at": "...", "hours_idle": 26, "fetched_at": "..." }` |
| proposed_action | 「この件、まだ返信がないようです。私が代わりに一次回答しましょうか？」 |
| 効果分類 | `external_send` |
| dryrun-first | ✅ |

### memory_conflict — 記憶の矛盾（全プリセット）

| 項目 | 内容 |
|---|---|
| 定義 | 本棚の2枚の読書カード/索引カードが互いに矛盾する内容を持つ（記憶汚染の早期検知にも寄与、§12-5） |
| reason_code 例 | `CARD_CONTRADICTION` / `ENTITY_ALIAS_CLASH` |
| facts 例 | `{ "book_a": "uuid", "book_b": "uuid", "conflict": "無料枠 5 vs 3", "fetched_at": "..." }` |
| proposed_action | 「本棚に食い違う記録があります。どちらが正しいですか？」→ 確認後に一方を annotate/archive |
| 効果分類 | `internal_write` |
| dryrun-first | ✅ |

## 完全性契約との関係（§6.3）

すべての kind は導出に使ったソースの `SourceResult(status)` を尊重する。

- `status=complete` のソースだけで「動きなし / succeeded_zero」を名乗れる。
- `partial / failed / unauthorized` に依存する Finding は **unknown に落とすか導出しない**。
- 例: Slack 取得が失敗している状態で deadline_risk を「該当なし」と結論してはならない。朝の始業報告では「今朝は一部チャンネルが見られていません」と言う（[`prompts/habits.md`](./prompts/habits.md)）。

## reason_code 命名規約

`SCREAMING_SNAKE_CASE`。kind 内で一意。将来 kind を追加するときは `reason_code` を必ずこの辞書に追記してから実装する（§9「未分類ツール・未知リソースは default deny」と同じ思想で、辞書にない reason_code は監査で弾く）。

> [!TODO] platform_bug / user_feedback の自動起票の週あたり件数上限（例: 3件/週）の確定 — 承認者: プロダクトオーナー + リポジトリ管理者（§6.4・[`equipment-ledger.md`](./equipment-ledger.md) の `github.issues` スコープと一致させる）。

> [!TODO] 追加提案 kind（stale_thread / memory_conflict）を初期辞書に含めるか、P3 以降に回すかの決定 — 承認者: プロダクトオーナー。

関連: [`presets.md`](./presets.md)（proactivity.triggers との対応）/ [`equipment-ledger.md`](./equipment-ledger.md)（効果分類）/ [`../operations/incident-response.md`](../operations/incident-response.md)（memory_conflict と記憶汚染）
