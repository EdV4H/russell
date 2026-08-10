# 記憶システム

記憶は自動で溜まる DB ではなく、エージェントが「自分は忘れる」と自覚して使う**道具**（設計書
[`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §1・§3）。
plugin-first では記憶は**コアの機能ではない**。`@edv4h/russell-plugin-memory-pg` が記憶 capability を
`ctx.services.provide('memory', …)` で公開し、記憶ツールを `ctx.tools` に register する。
コアの認知ループは `services.get('memory')` で capability を取得するだけで、Postgres も pgvector も知らない。

> [!NOTE]
> `memory-pg` は provider なので配列の**前方**に setup する（記憶を使う認知ループ・他プラグインより前）。
> IoC は同期的な rendezvous（[`../reference/31-core-api.md`](../reference/31-core-api.md)）。

## 4つの記憶メタファー

人間の記憶構造を実装の設計指針に写像する。ユーザーに見せる世界観ではなく内部機構。

| メタファー | 認知科学上の対応 | 技術実装（テーブル） |
|---|---|---|
| **メモ帳** | ワーキングメモリ | スレッド単位の短期ノート（TTL、既定7日）。`notes` |
| **日記** | エピソード記憶 | 夜間バッチが書く日次エントリ（イベント分節）。`journal_entries` |
| **本棚 + 索引カード** | 意味記憶 | キュレートされた知識 + エンティティリンク（Mem0 方式）。`books` / `entities` / `entity_links` |
| **書庫** | 長期忘却 | 減衰スコアで沈んだ記憶のコールドストレージ（`status='archived'`。**削除はしない**） |

「本」= 元情報 + 読書カード（エージェント自身の要約）+ marginalia（後から追記する書き込み）。
テーブル定義の全体は [`19-data-model.md`](./19-data-model.md)。

> [!IMPORTANT]
> **会話の文脈（進行中のやりとり）はこの体系に含まない**（[ADR 0002](../adr/0002-conversation-context-is-not-memory.md)）。
> 記憶システムは Bob が「**保つ**」ものの体系で、会話の文脈は「**いま抱えている**」もの。
> 単位（Slack のスレッド等）は通信面が決める概念であって、記憶の語彙ではない。
> 実装と扱いは [`../reference/31-core-api.md`](../reference/31-core-api.md) と
> [`13-surfaces.md`](./13-surfaces.md)。
>
> メモ帳と混ぜないこと。メモ帳は**書き留めたものだけが残る**記憶で、10秒前の発言を
> メモに取る人はいない。会話の全発言をメモ帳に流すと、夜間バッチが畳む日記が
> 「今日言われた全部」になって壊れる。

## 読み出しパス（会話時・予算 ~3,000トークン、§3.2）

1. 受信メッセージからエンティティ抽出（Haiku、~200ms）
2. 索引カード → リンクされた本・日記の断片を取得
3. 本棚をベクトル検索（active のみ）。ランキング `cos_sim × (0.5 + 0.5 × strength)` — よく使う記憶ほど思い出しやすい
4. 当該スレッドのメモ帳を全量注入

ヒットしなければ `deep_recall`（書庫 + 日記全文の低速検索）で「思い出す努力」を実際に行う。
読み出しパスの認知ループ内での位置づけは [`11-agent-core-and-loop.md`](./11-agent-core-and-loop.md)。

## 書き込みパス（ツールとして公開、§3.3）

`memory-pg` が register する記憶ツール。書き込みは自動蓄積ではなく明示的なツール呼び出し（「道具としての記憶」）。

| ツール | 動作 | 人間らしさ |
|---|---|---|
| `note.write(content)` | 現在スレッドのメモ帳に追記 | 「ちょっとメモしますね」 |
| `shelf.add(source, card)` | 読書カードを書いて本棚へ | 意図的に覚える行為 |
| `shelf.annotate(book_id, note)` | 既存の本に marginalia 追記 | 読み返して書き込む |
| `deep_recall(query)` | 書庫・日記の深掘り検索 | 思い出す努力 |
| `shelf.forget(query)` | 対象の本を書庫へ落とす（忘却の L1） | 「それはもういい」 |

> [!NOTE]
> **実装状況（2026-08-10）**: `note.write` / `shelf.add` / `shelf.forget` / `deep_recall` は登録済み。
> `shelf.annotate`（本への書き込み）と `entities` / `entity_links`（索引カード）は未実装。
> `deep_recall` はツールとしては通るが、認知ループから呼ぶ経路がまだ無い
> （自然言語で発火するのは「覚えて」「メモして」「忘れて」の3つだけ）。

## 忘却曲線（§3.4）

夜間バッチで全 book に適用する。忘れることは欠陥ではなく機能 — コンテキスト肥大と Lost-in-the-Middle への解答。

```
strength ← strength × exp(-λ × days_since_recall)  // λ ≈ 0.05
recall 時: strength ← min(1.0, strength + 0.3)       // 想起で強化（間隔反復）
strength < 0.2 → status = 'archived'（書庫へ。削除はしない）
```

`λ`（忘却率）はプリセットの「記憶力」軸のパラメータ（[`18-presets-and-temperament.md`](./18-presets-and-temperament.md)）。
人間が Slack で「これは覚えておいて」とピン留めした重要フラグは strength 下限 0.8 を保証する。

## 記憶汚染（Memory Poisoning）の構造的防止

> [!IMPORTANT]
> **日記への書き込みはエージェント自身には許可しない — 夜間バッチ専用**（§3.3）。
> 日中の会話で流れ込む untrusted テキスト（他人の発言・URL先）が、そのままエピソード記憶に固定される経路を断つ。
> エージェントが日中に触れるのはメモ帳と本棚だけで、それらが日記（永続記憶）へ昇格するかは夜間バッチが判断する。

多層の防御:

- **書き込み口の分離** — 日中は `note.write` / `shelf.add` のみ。日記は夜間バッチだけが書く
- **来歴の記録** — 夜間バッチは日記に来歴（どのイベント由来か）を必ず残す（§12-5）。汚染の監査可能性を確保
- **信頼ラベル伝播** — 記憶に取り込む外部テキストは `untrusted`。特権ツール引数に流れたらブロック
  （[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)）

## 記憶は個体間で共有しない（§8.4）

各個体（agent）の本棚・日記・playbook は完全に独立。`notes` / `books` / `journal_entries` 等には `agent_id` を付与して分離する。
分離しているからこそ、将来の2個体ディスカッション機能（P4）に本物の視点差が生まれる
（[`18-presets-and-temperament.md`](./18-presets-and-temperament.md) §8.4）。

## 記憶の全公開（§10.1）

記憶は透明性のためすべて人間から見える。日記は毎朝 `#<個体名>-日報` チャンネルへ投稿し、本棚は読み取り専用 Web UI（`/shelf`）で公開。
投稿・公開先は `surface` プラグインが担う（[`13-surfaces.md`](./13-surfaces.md)）。

## 関連

- 夜間コンソリデーション（日記生成・忘却適用）：[`17-habits-and-sleep.md`](./17-habits-and-sleep.md)
- データモデル（テーブル定義）：[`19-data-model.md`](./19-data-model.md)
- 認知ループ内での記憶：[`11-agent-core-and-loop.md`](./11-agent-core-and-loop.md)
