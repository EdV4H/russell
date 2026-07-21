# エージェントコアと認知ループ

Ryo の**コアは極小**で、具体的な機能を一切参照しない（[`10-plugin-architecture.md`](./10-plugin-architecture.md)）。
コアが持つのは (1) レジストリ群と `AgentContext` のライフサイクル、(2) **認知ループ**、(3) **Policy Gate の決定論的原値**の3つだけ。
記憶・通信面・装備・モデルはすべてプラグインが供給する。本章は設計書
[`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §2・§3・§11 を plugin-first で読み直す。

## 認知ループ

1会話ターンの骨格は次の5段。usketch の `createApp` が具体シェイプを知らないのと同じく、
コアはこの各段が「どのプラグインで実装されるか」を知らない。

```
記憶読出し → 文脈構築 → モデル呼出し → Policy Gate を通したツール実行 → 記憶書込み
```

| 段 | 何をするか | 実体はどこ |
|---|---|---|
| 記憶読出し | 受信メッセージから関連記憶を引く（§3.2 読み出しパス） | `memory` capability（`memory-pg` が `services` 経由で提供） |
| 文脈構築 | 人格プロンプト + 記憶 + スレッド履歴を組む | コア（temperament から人格生成、[`18-presets-and-temperament.md`](./18-presets-and-temperament.md)） |
| モデル呼出し | 文脈をLLMへ | `models` レジストリのプロバイダ（`model-claude`） |
| ツール実行 | モデルが選んだツールを **Policy Gate 通過後**に実行 | `tools` / `equipment` プラグインが register したツール |
| 記憶書込み | 会話の産物をメモ帳・本棚へ | 記憶ツール（下記書き込みパス） |

> [!IMPORTANT]
> ツール実行は必ず Policy Gate を通る。エージェント（LLM）は特権を持たない。
> 未支給の装備はツール定義自体がコンテキストに載らない（§9.2）ので、モデルは持っていない能力の存在すら知らない。
> 決定論的判定の詳細は [`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)。

## トークン予算（1ターン ≒ ~10k tokens）

日中のレイテンシとコストを守るため、1会話ターンの予算配分を固定する（§11）。重いLLM処理は夜間へ寄せる
（[`17-habits-and-sleep.md`](./17-habits-and-sleep.md)）。

| 用途 | 予算 |
|---|---|
| システム + 人格プロンプト | 1.5k |
| 記憶注入（読み出しパス） | 3k |
| スレッド履歴 | 4k |
| 応答 | 2k |
| **合計** | **~10k tokens/ターン** |

記憶注入が3kに収まるのは「忘れることが機能」だから（[`12-memory-system.md`](./12-memory-system.md)）。
active な本棚だけを対象にし、減衰した記憶は書庫へ落として注入対象から外す。これがコンテキスト肥大と
Lost-in-the-Middle への解答になる。

## 読み出しパス（会話時・予算 ~3,000トークン、§3.2）

1. 受信メッセージからエンティティ抽出（Haiku、~200ms）
2. 索引カード → リンクされた本・日記の断片を取得
3. 本棚をベクトル検索（active のみ）。ランキングは `cos_sim × (0.5 + 0.5 × strength)` — よく使う記憶ほど思い出しやすい
4. 当該スレッドのメモ帳を全量注入

ヒットしない場合、エージェントは「うろ覚えなので書庫を探します」と宣言して `deep_recall`（書庫 + 日記全文の低速検索）を使う。
**即答できないことを演技ではなく実際の構造**として持つ。

## 書き込みパス（ツールとして公開、§3.3）

記憶への書き込みは自動蓄積ではなく、明示的なツール呼び出し。`memory` プラグインが `ctx.tools` に register する。

| ツール | 動作 | 人間らしさ |
|---|---|---|
| `note.write(content)` | 現在スレッドのメモ帳に追記 | 「ちょっとメモしますね」 |
| `shelf.add(source, card)` | 読書カードを書いて本棚へ | 意図的に覚える行為 |
| `shelf.annotate(book_id, note)` | 既存の本に marginalia 追記 | 読み返して書き込む |
| `deep_recall(query)` | 書庫・日記の深掘り検索 | 思い出す努力 |

> [!NOTE]
> **日記への書き込みはエージェント自身には許可しない**（夜間バッチ専用）。
> 日中の記憶汚染（Memory Poisoning）を構造的に防ぐ。詳細は [`12-memory-system.md`](./12-memory-system.md)。

## コアに残るもの / プラグインが供給するもの

| コア（極小） | プラグイン |
|---|---|
| 認知ループの制御フロー | モデル呼出しの中身（`models` = `model-claude`） |
| レジストリ群 + `AgentContext` のライフサイクル | 記憶 capability（`memory-pg` が `services.provide('memory', …)`） |
| Policy Gate 決定論的原値（未登録=deny・killswitch・fail-closed） | 効果分類の申告（装備プラグインが `ctx.policy` へ） |
| `runtime`（config_version pin・mode・killSwitch 別経路） | 通信面（`surface-*`）・装備（`equipment-*`）・気づき（`finding-*`）・習慣（`habit-*`） |

配列順は load-bearing。`services`/`memory` → `models` → `equipment` → `surfaces` → `routines` → `findings` の順に setup する
（[`../reference/31-core-api.md`](../reference/31-core-api.md)）。

## 2プロセス構成（app + worker、§2）

プロセスは**単一アプリ + ワーカーの2つ**。マイクロサービス化しない。ただしプロセス内で対話系とバッチ系の
ワーカープール・並列度上限を分離し、バッチがAPI予算を食い潰して対話が詰まる事態を防ぐ（Frank v2 の運用知見）。

- **app** — 通信面（`surface-*`）+ 認知ループ + Policy Gate。会話・HITL 応答を担う
- **worker** — 夜間コンソリデーション（§4）、dispatcher（習慣・§5.1）、気づきスコアラー。
  キューは pg-boss で Postgres に同居

両プロセスとも同じプラグイン契約の上に立つ。dispatcher と夜間バッチは worker 側で
`routines` / `findings` レジストリを駆動する（[`17-habits-and-sleep.md`](./17-habits-and-sleep.md)、
[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)）。

## 関連

- プラグイン契約：[`../reference/30-ryo-plugin-contract.md`](../reference/30-ryo-plugin-contract.md)
- コアAPI・起動シーケンス：[`../reference/31-core-api.md`](../reference/31-core-api.md)
- 記憶システム：[`12-memory-system.md`](./12-memory-system.md)
- データモデル：[`19-data-model.md`](./19-data-model.md)
