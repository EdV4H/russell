# P4以降バックログ

> [!NOTE]
> 準備物 C-3。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §8.4（ディスカッション機能）・残課題3（プリセット追加軸）・残課題4（ディスカッション詳細）が源泉。
> P0〜P3（§13）の外側。**着手はドッグフーディング（[`../dogfooding/plan.md`](../dogfooding/plan.md)）で価値が確認できてから。** ここでは方針だけ整理しておく。

## 優先度の考え方

| 優先 | 項目 | 依存 |
|---|---|---|
| P4 | 2個体ディスカッション機能 | 複数個体が live で安定運用できていること |
| P4 | 管理画面（Web UI 拡張） | Finding/装備/config_version が出揃っていること |
| 随時 | 設計書の英訳/図解 | 外注先が海外/多国籍の場合のみ |
| 随時 | プリセット追加軸（ムードメーカー等） | 業務価値の間接性を許容する合意 |

---

## 1. 2個体ディスカッション機能（§8.4・残課題4）

§8.4 で「決定 + P4候補」。記憶は個体間で共有しない（決定事項）からこそ本物の視点差が生まれる、という前提の上に載る機能。

### 設計書で決まっていること（§8.4）

- 場所は **Slack スレッド上**（隠れた内部 swarm にしない。人間が観戦・割り込み可能）
- 起動は人間が指名（`@覚 @詩織 これ二人で詰めといて`）。議題を明示
- **収束の強制**: 自由対話にしない。ラリー上限（既定6往復）+ 終了時に片方が「合意点 / 相違点 / 人間への確認事項」を要約
- 記憶: 各個体が自分のメモ帳→夜間に各自の日記へ。同じ議論を2体が違うふうに記憶する
- セキュリティ: 相手個体の発言は `untrusted`（Cross-agent trust exploitation 対策）。相手発言を根拠に特権ツールは発火しない（連鎖感染の遮断）

### 残課題4（詰める点）

- ラリー上限の適正値（6往復で足りるか、議題種別で可変にするか）
- 3体以上に拡張するか（トークン激増・予測不能のリスク, §8.4）
- 人間が割り込んだときの振る舞い（一時停止 / 割り込みを新入力として取り込む / 議題を差し替える）
- コスト影響: 2体 × 6往復は1タスクで対話ターンが跳ねる → [`../operations/cost-budget.md`](../operations/cost-budget.md) に別枠

### plugin-first での位置づけ

ディスカプションは新レジストリを増やさず、既存の `surfaces`（Slack スレッド）+ `events`（`surface:message`）+ 複数個体の `createAgent` インスタンス間の調停として実装できる想定。調停ロジック（ラリー上限・収束強制）をどこに置くか（コア or `habit-*`/専用プラグイン）は設計時に決める。

> [!TODO] ディスカッション機能に着手する条件（何個体が live で安定したら）とラリー上限の初期値の決定 — 承認者: プロダクトオーナー。まず2体・6往復・Slack スレッドで最小実装し、3体拡張は別途判断。

## 2. 管理画面（Web UI 拡張）

§10.1 で読み取り専用 Web UI（`/shelf` 本棚・`/equipment` 装備一覧）は決定済み。その先の管理系。

候補機能:
- Finding の一覧・状態遷移ビュー（detected/notified/acknowledged/resolved/suppressed, §6.2）
- config_version の履歴・diff・ワンクリック rollback（§6.1）
- 装備の支給/回収 UI（`issuances` 編集, §9。現状は `/ryo config` + 台帳直編集）
- 使用量台帳の個体別コスト＝人件費ダッシュボード（§11・[`../operations/cost-budget.md`](../operations/cost-budget.md)）
- dryrun 出力のレビュー UI（`#ryo-管理` の Slack 手作業を置き換え, §6.5・[`../dogfooding/plan.md`](../dogfooding/plan.md)）

> [!TODO] 管理画面の要否と範囲の決定 — 承認者: プロダクトオーナー。当面は Slack（`/ryo config` + `#ryo-管理`）+ 読み取り専用 Web UI で回し、運用負荷が上がってから投資する。

## 3. 設計書の英訳/図解（C-3・外注先が海外の場合）

- 外注先が海外/多国籍なら、[`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) と [`plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md) の英訳が要る
- 図解版（アーキテクチャ図 §2・記憶フロー §3・気づきパイプライン §6）は言語を問わず理解を助ける
- 用語集（[`../../getting-started/02-glossary.md`](../../getting-started/02-glossary.md)）を英対訳で持つと、装備/Finding/temperament 等の訳ブレを防げる

> [!TODO] 外注先の言語と、英訳/図解の要否の決定 — 承認者: プロダクトオーナー（A-3 の発注スコープと同時に）。国内発注なら不要。

## 4. プリセット追加軸（残課題3）

§8.3 の初期4種（スポンジ/編集者/番頭/石橋）の先。**業務価値が間接的なタイプを入れるか**が論点。

候補軸/タイプ:
- ムードメーカー（残課題3 の例）: 雑談・場の潤滑。業務 KPI に直結しない価値をどう評価するか
- その他: メンター（新人個体の育成補助）、アーキビスト（記憶の整理特化）等

追加時のチェックリスト（§8.1 の設計原則を守る）:
- [ ] どの軸を削り、どの行動で補償するか（全パラメータ最大にしない）
- [ ] [`../initial-data/presets.md`](../initial-data/presets.md) の共通スキーマで表現できるか、新しい config キー/レジストリが要るか
- [ ] 成功指標をどう測るか（[`../dogfooding/plan.md`](../dogfooding/plan.md)。間接価値は「同僚感」スコア寄りになる）
- [ ] 装備の支給範囲（[`../initial-data/equipment-ledger.md`](../initial-data/equipment-ledger.md)）

> [!TODO] ムードメーカー等の間接価値タイプを入れるかの決定 — 承認者: プロダクトオーナー。初期4種の価値が実証できてから。plugin-first なので追加は「プラグイン配列 + config レシピ」を1つ足すだけで、コア変更は不要な想定（[`../initial-data/presets.md`](../initial-data/presets.md)）。

## 対応しない/後回しにするものの明示

- 個体間の記憶共有: **やらない**（§8.4 決定事項）。視点差が消える
- マイクロサービス化: やらない（§2。単一アプリ + worker の2プロセスを維持）
- Slack 以外の surface（Discord/CLI/Web/音声）: plugin-first で差し替え可能な設計だが、優先度は価値実証後（[`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）

関連: [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §8.4・§14 残課題 / [`../dogfooding/plan.md`](../dogfooding/plan.md) / [`../operations/cost-budget.md`](../operations/cost-budget.md)
