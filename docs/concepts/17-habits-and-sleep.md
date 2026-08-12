# 習慣と睡眠（Habits & Sleep）

生活リズム — 習慣（手続き記憶）と睡眠（記憶の固定化）— は人間らしさを構造として実装する装置
（設計書 [`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §4・§5）。
plugin-first では習慣を `habit-*` プラグインとして実装し、`ctx.routines.register(routineDef)` でルーティンを登録する。
**dispatcher と夜間バッチは worker プロセスに住む**（[`11-agent-core-and-loop.md`](./11-agent-core-and-loop.md) の2プロセス構成）。

## 習慣エンジン（§5）

### ビルトイン習慣（3種）

`habit-morning` / `habit-evening` / `habit-weekly` が register する。

| 習慣 | cron | 内容 |
|---|---|---|
| 朝の始業 | `0 9 * * 1-5` | 未読 Slack レビュー → 今日の計画をメモ帳へ → 必要なら「おはようございます、今日は〜を進めます」と投稿 |
| 夕方の振り返り | `0 18 * * 1-5` | 今日のタスク消化を確認、未完了を明日へ繰り越し |
| 週次レビュー | `0 17 * * 5` | 週のまとめをチャンネルに投稿、本棚の棚卸し |

### 学習される習慣（§5・成長との接続）

夜間バッチのパターンマイナーが日記を横断し、「毎週月曜に X を頼まれている」等の繰り返しを検出
→「これ、毎週こちらでやっておきましょうか？」と Slack ボタンで本人に提案
→ 承認で `routines` に `origin='learned'` として追加。

> [!IMPORTANT]
> **勝手に習慣を作らない。** 提案して許可を得るのが同僚らしさであり、HITL ゲートでもある。

## dispatcher 方式（§5.1、Frank v2 から採用）

静的 cron の直接実行はやめ、固定間隔 tick で「実行期限を迎えたルーティン」を DB から claim する dispatcher 方式にする。
dispatcher はコアではなく **worker** に住み、`routines` レジストリに登録されたルーティンを駆動する。

- **claim** — `next_run_at` + timezone + 営業日カレンダー。`FOR UPDATE SKIP LOCKED` で取り合う
- **lease + fencing token + heartbeat** — 長時間処理で lease が切れても二重投稿しない。
  `(agent_id, routine_id, scheduled_for)` の一意制約で論理実行は1件
- **catch-up policy** — サーバー停止後の再開時、溜まった実行を `skip` / `coalesce` / `replay_once` から選択
  （既定 `coalesce`=まとめて1回）。復旧直後に朝の挨拶が5連投される事態を構造的に防ぐ
- 副作用（投稿）の直前に**モードとキルスイッチを再検査**（[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)）
- **実行結果を細分化して記録** — `succeeded` / `succeeded_zero` / `degraded` / `failed` / `skipped`。
  `succeeded_zero`（正常に報告事項ゼロ）を名乗れるのは全ソース取得が complete のときだけ
  （§6.2 の完全性契約。[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)）

> [!IMPORTANT] **決定（2026-08-12）: dispatcher を実装した。**
> `pnpm --filter @edv4h/russell-worker dispatch [--watch]`（worker に住む）。
>
> - 予定は台帳（`routines`）に持ち、tick ごとに**実行期限を迎えたものを claim** する
> - 二重実行の防止は2段階: claim は `FOR UPDATE SKIP LOCKED`、**論理的な一意性**は
>   `(agent_id, routine_id, scheduled_for)` の一意制約。claim をすり抜けても実行は1件
> - リースが切れた（heartbeat が途絶えた）実行は別のプロセスが引き取れる。
>   引き取りのたびに `fence` が上がり、**古い実行者の書き込みは通らない**
> - **失敗した予定時刻は進めない。** 次の tick で取り直せるようにしておく
> - 遡る上限は14日。止まっていた期間が長いほど、古い予定の価値は下がる
> - 最初の予定は登録した**直前の1回だけ**を候補にする（登録した瞬間に過去分が湧かない）
>
> **日報だけの cron を作らなかった。** 単発で作ると、定期タスクを足すときに別経路が
> もう1つできる。日報は dispatcher に載る最初のルーティン（`journal`, `0 3 * * *`,
> catch-up は `replay_once`——日報は日付ごとに意味があるので、溜まった分は1日ずつ書く）。
>
> **手で流す口も残してある**（`pnpm consolidate`）。ただし実行部は共有していて、
> 「手動では動くが自動実行では設定が違う」という差を作らないようにしてある。

> [!NOTE]
> catch-up policy の既定が `coalesce` なのは、「動いていなかった間の分を全部やり直す」より
> 「今の状態を1回だけ報告する」ほうが同僚らしいから。復旧の挙動まで人間らしさに接続している。

## 睡眠コンソリデーション（§4、夜間バッチ 03:00 JST）

MAGMA の Slow Path 相当。**重い LLM 処理はすべてここに寄せ**、日中のレイテンシとトークン消費（~10k/ターン）を守る
（[`11-agent-core-and-loop.md`](./11-agent-core-and-loop.md)）。worker が実行する6ステップ:

1. **日記を書く** — 未処理メモ + 当日の Slack ログをイベント分節（CompassMem 的に「意味のある出来事」単位に切る）→ `journal_entries` 1件
2. **教訓の抽出** — 各イベントから lesson を抽出 → 該当 playbook へマージ提案（confidence 加重）。
   失敗イベントは Reflexion 的に「次はどうするか」を必ず含める
3. **本棚の編集** — **3件以上のメモに現れた話題を「本」に昇格**（読書カードを書く）。エンティティリンク更新。
   続けて、**重複した本を1冊に畳み、内容を表していない見出しを付け直す**（下記）
4. **忘却の適用** — 減衰 + 書庫スイープ（§3.4 の忘却曲線。[`12-memory-system.md`](./12-memory-system.md)）
5. **関心の更新** — 当日の話題頻度から `interests` を再重み付け
6. **明日の準備** — 朝のルーティンが読む「今日やることメモ」を下書き

> [!IMPORTANT]
> **処理は冪等に設計し、日付キーで再実行可能にする**（§4）。
> 夜間バッチが途中で落ちても、同じ日付で再実行すれば結果は一意になる。

> [!IMPORTANT] **決定（2026-08-11）**
> **本棚の整理（重複の統合・見出しの付け直し）は、すべて可逆にする。** 畳まれた本は消さずに
> 書庫へ下げ、**残す側の元の文章も上書き前に書庫へ控える**。まとめる判断はモデルが行うが、
> 返された id は実在する本だけに絞ってから適用する（§12-3）。
> `pnpm consolidate --dry-run` は**何も書き込まず**に計画だけを見せる。
> → [ADR 0004](../adr/0004-shelf-organizing-is-reversible.md)

> [!IMPORTANT] **決定（2026-08-11）**
> **本は原則ここで作る。会話中に直接書くのは明示的に頼まれたときだけ。**
> 会話中の1往復から note と shelf を同時に書かせたら、メモ帳と本棚の粒度が同じになった——
> 同じ材料を2回要約しているので当然だった。本は**複数のメモを横断して**書かれるから
> 一段抽象度が上がる。昇格は整理より先に走らせ、同じ夜のうちに重複判定へ回す。
> → [ADR 0005](../adr/0005-books-are-promoted-from-notes.md)

夜間バッチはこの他に、学習される習慣のパターンマイニング（§5）、セルフイシューの昇格・クローズ見届け（§6.4）、
報告済み Issue の状態確認も行う（[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)）。

## 関連

- `RoutineRegistry` の型：[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)
- モード・キルスイッチの再検査：[`../reference/31-core-api.md`](../reference/31-core-api.md)
- データモデル（`routines` / `journal_entries` / `playbooks` / `interests`）：[`19-data-model.md`](./19-data-model.md)
