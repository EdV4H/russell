# プラグインアーキテクチャ（極小コア + プラグイン）

Russell は **極小コア + プラグイン**（PluginParty）で構成する。手本は同一モノレポ親 `~/Projects/usketch`
（全機能を統一プラグインAPIで実装するホワイトボード）。設計転換の背景は
[`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)。

## 原則

> **コアは具体的な機能を一切参照しない。** コアが知っているのは「レジストリ」と「プラグインのライフサイクル」だけ。
> Slack も GitHub も記憶も気づきも、コアにとっては「あるレジストリに register してきた誰か」でしかない。

これにより:
- **Slack は `surface` プラグインの一実装**にすぎず、Discord / CLI / Web / 音声へ差し替え可能
- 新しい装備の追加＝プラグインを1つ書いて配列に足すだけ。コアのコード変更は不要（設計書§9.1の思想を全域へ一般化）
- テストは `surface-cli` で完結し、外部依存なしにコアを検証できる
- セキュリティ以外の判断がプラグインに閉じる（Policy Gate 原値だけはコアが握る。後述）

## 3つの登場人物

### 1. コア（`@edv4h/russell-core`）

`createAgent(config, plugins[])` が:
1. 直交する**レジストリ群**を生成する
2. それらを単一の **`AgentContext`** に束ねる
3. プラグイン配列を**順に** `await plugin.setup(ctx)` する
4. 各 `setup` が返す **teardown クロージャ**を収集し、破棄時に LIFO で実行する
5. いずれかの `setup` が throw したら、それまでの teardown を巻き戻す（部分初期化を残さない）

コアはこのループと、認知ループ（記憶読出し→文脈構築→モデル呼出し→Policy Gateを通したツール実行→記憶書込み）、そして **Policy Gate の決定論的原値**だけを持つ。

### 2. プラグイン契約（`RussellPlugin`）

```ts
interface RussellPlugin {
  readonly id: string;
  readonly name: string;
  setup(ctx: AgentContext): RussellTeardown | void | Promise<RussellTeardown | void>;
}
type RussellTeardown = () => void | Promise<void>;
```

- **種別フィールド（`type`/`kind`）は持たない。** プラグインは「`setup` の中でどのレジストリに register するか」で自己分類する。surface プラグインは `ctx.surfaces.register(...)`、装備プラグインは `ctx.equipment.register(...)` を呼ぶ。コアはプラグインの種類で分岐しない。
- **teardown は `setup` の戻り値**（プロパティに置かない）。同じプラグインインスタンスで `setup` が二度呼ばれても壊れない。
- 1つのプラグインが複数レジストリに触れてよい（例：`memory-pg` は `ctx.services.provide('memory', …)` と `ctx.tools.register('note.write', …)` の両方）。

### 3. プリセット = 組み立てレシピ

usketch では `apps/web/app.tsx` がプラグイン配列を組む。Russell ではその役割を**プリセット**が担う。
個体を起動するとき、プリセット（スポンジ/編集者/番頭/石橋）が temperament・記憶パラメータ・支給装備に応じて
**どのプラグインを** どの config で配列に並べるかを決める。詳細は [`../guides/24-defining-a-preset.md`](../guides/24-defining-a-preset.md)。

## AgentContext のレジストリ

コアが提供する直交スロット。プラグインはここに register することで機能を提供する。

| レジストリ | 役割 | 主な register 元プラグイン |
|---|---|---|
| `surfaces` | 通信面（受信購読・送信・HITLプロンプト） | `surface-slack` / `surface-cli` / `surface-web` |
| `equipment` | 装備 = MCP接続 + scope + danger + 効果分類 | `equipment-github` / `-notion` / `-terminal` |
| `tools` | エージェントが呼べるツール | 記憶ツール・装備由来ツール |
| `memory` | 記憶 capability（services 経由で提供） | `memory-pg` |
| `routines` | 習慣（dispatcher が claim する登録簿） | `habit-morning` / `-evening` / `-weekly` |
| `findings` | 気づき種別（kind ごとの検知器） | `finding-deadline-risk` / `-platform-bug` … |
| `models` | LLMプロバイダ（Sonnet/Haiku/Opus） | `model-claude` |
| `policy` | Policy Gate 拡張（効果分類・HITL要否・事前承認） | 装備プラグインが自分の効果分類を登録 |
| `events` | イベントバス（型なしフォールバック） | 全プラグイン |
| `services` | IoC（DB/pgvector・埋め込み・config_versionストア） | 基盤プラグイン |

各レジストリの型は [`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)。

## プラグイン間の疎結合（usketch の3経路 + α）

1. **イベントバス `ctx.events`** — 型付き既知イベント + `string` フォールバックで自由にイベント名を発明。
   例：`surface-slack` が受信を `surface:message` で emit → `finding-*` が購読してスコアリング。互いを import しない。
   （リプレイしないので、購読側は emit 側より**前**に setup される順序制約に注意。§配列順）
2. **IoC サービスマップ `ctx.services`** — `provide(key, impl)` / `get(key)`。提供元を import せず capability を取得。
   例：`memory-pg` が `services.provide('memory', memoryImpl)` → 認知ループや他プラグインが `services.get('memory')`。
3. **共有状態** — 個体の実行状態（現在の config_version、モード off/dryrun/live、キルスイッチ状態）はコアが保持し、プラグインは読み取る。
4. **priority / last-wins オーバーライド** — 同一拡張点に複数プラグインが競合し得る箇所（例：surface の送信ハンドラ）は priority で勝者を決める。

## 配列順は load-bearing

`setup` は逐次実行され、イベントバスはリプレイしない。したがって:
- **provider は consumer より前**（`memory-pg` → 記憶を使うプラグイン、`surface-*` → surface イベントを購読する `finding-*`）
- **Policy Gate 原値はコアが最初に確立**してから、装備プラグインが効果分類を register する

順序と依存の規約は [`../reference/31-core-api.md`](../reference/31-core-api.md) に集約。

## セキュリティはプラグインに委ねない

plugin-first でも、**Policy Gate の決定論的原値だけはコアが握る**（設計書§12）:
- 「未登録・未知の効果は default deny」
- 「killswitch が最優先」「fail-closed（ポリシー情報が読めなければ送信・書込みしない側に倒す）」
- キルスイッチは DB 障害時にも効く別経路（env / プロセスシグナル）を持つ

装備プラグインは自分の効果分類・HITL要否を `ctx.policy` に**申告**するが、判定の枠組みと下限はコアが強制する。
詳細は [`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)。

## 命名規約

| 種別 | パッケージ名 | 例 |
|---|---|---|
| surface | `@edv4h/russell-plugin-surface-{name}` | `russell-plugin-surface-slack` |
| equipment | `@edv4h/russell-plugin-equipment-{name}` | `russell-plugin-equipment-github` |
| memory | `@edv4h/russell-plugin-memory-{name}` | `russell-plugin-memory-pg` |
| finding | `@edv4h/russell-plugin-finding-{name}` | `russell-plugin-finding-deadline-risk` |
| habit | `@edv4h/russell-plugin-habit-{name}` | `russell-plugin-habit-morning` |
| model | `@edv4h/russell-plugin-model-{name}` | `russell-plugin-model-claude` |

ファイルは kebab-case、各プラグインは `createXxxPlugin()` ファクトリを default でなく named export。
パッケージ全体像は [`../reference/33-package-layout.md`](../reference/33-package-layout.md)。
