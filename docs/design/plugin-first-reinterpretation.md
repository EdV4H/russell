# Plugin-First 再解釈ノート

> [!IMPORTANT]
> このノートは元設計書 [`human-like-agent-design.md`](./human-like-agent-design.md) の **§2（全体アーキテクチャ）と §10（Slack統合）が置いている「Slack常駐」前提を上書きする**、明示的な設計方針の転換記録です。
> 元設計書の記憶・気づき・装備・プリセット等の**内容そのものは有効**で、変わるのは「それらをどう構造化するか」だけです。

## 何を変えるか（一文）

**Slack常駐はRyoのコアではない。Slackは「コミュニケーションツールというプラグインの一つ」に過ぎない。**
コアはエージェント（記憶＋生活リズム＋認知ループ）であり、通信面（surface）すら差し替え可能なプラグインとして外に出す。

同一モノレポ親（`~/Projects/usketch`）の「PluginParty」アーキテクチャ — 全機能（ツール/シェイプ/背景/AI/プレゼン）を統一プラグインAPIで実装する — を手本に、Ryoも**極小コア＋プラグイン**で構成する。

## なぜ変えるか

- 元設計書は Slack Gateway をアーキ図の入口に固定し、Slack を第一級市民として扱っている（§2, §10, §11 の技術スタックも Bolt/Socket Mode を前提）。
- しかし Ryo の本質は「一人の同僚がそこにいる」であって、それが**どの面に現れるか**（Slack / Discord / CLI / Web / 音声）は本質ではない。
- 通信面をコアから剥がすと、(1) Slackへのロックインが消え、(2) テストが `surface-cli` で完結し、(3) 「装備＝MCP」という既存の疎結合思想（§9）と設計が一枚岩になる。
- 装備（§9）は既に「MCPサーバーを台帳に登録するだけで本体コード変更不要」という**事実上のプラグイン**として設計されている。この思想を surface・気づき・習慣・モデルにも一般化するだけ。

## usketch から採用するパターン

`~/Projects/usketch` の権威ソース（`packages/shared/src/types/plugin.ts`, `packages/core/src/create-app.ts`）から：

1. **極小ホスト**：`createApp(plugins[])` が直交レジストリ群を生成 → 単一のコンテキストオブジェクトに束ねる → プラグイン配列を順に `setup(ctx)` 実行 → teardown を収集。**コアは具体機能を一切参照しない**。
2. **プラグイン契約は `{id, name, setup(ctx)}` のみ**。`type`/`kind` フィールドは存在しない。プラグインは「どのレジストリに register するか」で自己分類する（shape も tool も bg も AI も同一契約）。
3. **teardown は `setup` の戻り値**（プロパティではない）。二重 `setup` でも壊れない。
4. **疎結合の3経路**：共有ストア（reactive state）／イベントバス（型なしフォールバックで自由にイベント名を発明）／IoC サービスマップ（`services.get(key)` で提供元を import せず capability を取得）。加えて priority/last-wins のオーバーライドレジストリ。
5. **配列順は load-bearing**：`setup` は逐次実行、イベントバスはリプレイしない。provider は consumer より前に置く。
6. **monorepo**：`packages/core`（カーネル）・`packages/shared`（契約/型）・`plugins/*`（全機能）・`examples/*`（テンプレ）・`apps/*`（組み立て + docs）。命名 `{scope}-plugin-{kind}-{name}`、ファイル kebab-case、`create*Plugin()` ファクトリ、`react` 等は peerDeps。

## Ryo への写像

| usketch | Ryo |
|---|---|
| `createApp(plugins[])` | `createAgent(plugins[])`（コア = 認知ループ + レジストリ + Policy Gate原値） |
| `PluginContext` | `AgentContext`（下記レジストリの束） |
| `UsketchPlugin {id,name,setup}` | `RyoPlugin {id,name,setup}` |
| shape/tool/bg/ai plugin | surface / equipment / memory / finding / routine / model plugin |
| `apps/web/app.tsx` がプラグイン配列を組む | **プリセット**が個体ごとにプラグイン配列 + config を組む |
| `ctx.shapes.register(...)` | `ctx.equipment.register(...)`, `ctx.surfaces.register(...)`, … |
| event bus | Slackイベント → 気づき、装備結果 → Finding、等の疎結合 |
| IoC `services` | DB/pgvector・埋め込み・config_version ストア・記憶capability |

### AgentContext のレジストリ（コアが提供する直交スロット）

- `surfaces` — 通信面（受信購読・送信・HITLプロンプト）。**Slack はここに register する一プラグイン**
- `equipment` — 装備（MCP接続 + scope + danger_level + 効果分類）。§9 をそのままプラグイン化
- `tools` — エージェントが呼べるツール（`note.write`/`shelf.add`/`deep_recall` もここ）
- `memory` — 記憶 capability。`memory` プラグインが services 経由で提供し、記憶ツールを tools に register
- `routines` — 習慣（dispatcher が claim する登録簿。§5.1）
- `findings` — 気づき種別（kind ごとの検知器。§6.2）
- `models` — LLMプロバイダ（Sonnet/Haiku/Opus 選択。§8.1「賢さ」軸）
- `policy` — Policy Gate 拡張（効果分類の登録、HITL要否、スコープ付き事前承認）
- `events` — イベントバス
- `services` — IoC（DBハンドル・埋め込み・config_versionストア等）

### コアに残すもの（極小コア・決定事項）

- 認知ループ（記憶読出し → 文脈構築 → モデル呼出し → Policy Gate を通したツール実行 → 記憶書込み）
- レジストリ群と `AgentContext` の生成・プラグインのライフサイクル（setup/teardown・順序制約）
- **Policy Gate の決定論的原値**：allowlist 判定の枠組み・fail-closed・キルスイッチの別経路（env/シグナル）。
  個々の効果分類やHITL要否はプラグインが `policy` に register するが、「未登録・未知はdeny」「killswitchが最優先」という原値はコアが持つ（セキュリティをプラグインに委ねない）

### プラグインに出すもの

記憶（`memory-pg`）／通信面（`surface-slack` ほか）／装備（`equipment-*`）／気づき種別（`finding-*`）／習慣（`habit-*`）／モデル（`model-claude`）。

## この転換が影響する準備物

- **装備台帳（B-1）** は「equipment プラグインの一覧」として書ける → [`../preparation/initial-data/equipment-ledger.md`](../preparation/initial-data/equipment-ledger.md)
- **装備 conformance suite（A-2）** は「全プラグインが満たすべき共通契約テスト」に一般化 → [`../preparation/acceptance/equipment-conformance-suite.md`](../preparation/acceptance/equipment-conformance-suite.md)
- **スコープ書（A-3）** の発注単位は「どのプラグインを外注するか」で切れる（コア＝内製、surface/equipment＝外注、等）
- **プリセット（B-1）** は「プラグイン配列 + config の組み立てレシピ」として定義 → [`../guides/24-defining-a-preset.md`](../guides/24-defining-a-preset.md)

## 詳細仕様

- コンセプト・契約：[`../concepts/10-plugin-architecture.md`](../concepts/10-plugin-architecture.md)
- API リファレンス：[`../reference/30-ryo-plugin-contract.md`](../reference/30-ryo-plugin-contract.md), [`../reference/31-core-api.md`](../reference/31-core-api.md)
- パッケージ構成：[`../reference/33-package-layout.md`](../reference/33-package-layout.md)
