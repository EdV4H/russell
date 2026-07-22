# ガイド: プラグインを書く（共通スケルトン）

このガイドは、種別を問わずすべての Russell プラグインが従う**共通の骨格**を示す。surface / equipment / finding など個別の書き方は、この骨格を前提に各専用ガイドで扱う:

- [`21-authoring-a-surface.md`](./21-authoring-a-surface.md) — 通信面
- [`22-authoring-equipment.md`](./22-authoring-equipment.md) — 装備（MCP）
- [`23-authoring-a-finding.md`](./23-authoring-a-finding.md) — 気づき種別
- [`24-defining-a-preset.md`](./24-defining-a-preset.md) — プリセット（プラグインの組み立て）

前提となる契約は [`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)、
ライフサイクルは [`../reference/31-core-api.md`](../reference/31-core-api.md)、
設計背景は [`../concepts/10-plugin-architecture.md`](../concepts/10-plugin-architecture.md) を参照。

> [!NOTE] 提案仕様
> 本ガイドのコードは docs-only 段階の**提案**であり、実装は未作成。型は実装時に `@edv4h/russell-shared` で確定する。
> 手本は usketch の `plugins/*/src/plugin.tsx`（例: `usketch-plugin-bg-dots`, `usketch-plugin-tool-pan`）。

## RussellPlugin は3つだけ

プラグインは `{id, name, setup(ctx)}` の3要素しか持たない。**種別フィールド（`type`/`kind`）は存在しない。**

```ts
export interface RussellPlugin {
  readonly id: string;   // 一意。パッケージ名に揃える（例 "russell-plugin-surface-slack"）
  readonly name: string; // 人間向け表示名
  setup(ctx: AgentContext): RussellTeardown | void | Promise<RussellTeardown | void>;
}
export type RussellTeardown = () => void | Promise<void>;
```

- **自己分類**は「`setup` の中でどのレジストリに register するか」で決まる（後述）。コアはプラグインの種類で分岐しない。
- **状態は `setup` 内のクロージャ**に持つ。プラグインオブジェクトのプロパティには置かない。
- **teardown は `setup` の戻り値**で返す（プロパティではない）。同じインスタンスで `setup` が二度呼ばれても壊れない。

## 最小スケルトン

どの種別でもこの形をコピーして始める。ファクトリ `createXxxPlugin()` を named export し、`setup` の末尾で teardown クロージャを返す。

```ts
// src/plugin.ts
import type { AgentContext, RussellPlugin } from "@edv4h/russell-shared";

export function createExamplePlugin(options?: ExampleOptions): RussellPlugin {
  return {
    id: "russell-plugin-example",
    name: "Example",

    setup(ctx: AgentContext) {
      // 1) 状態はこのクロージャに閉じる
      let started = false;

      // 2) 自分の役割に対応するレジストリへ register する（= 自己分類）
      const unregister = ctx.tools.register("example.ping", {
        /* ToolSpec … */
      });

      // 3) 疎結合はイベントバス / services 経由（相手を import しない）
      const off = ctx.events.on("mode:changed", () => {
        /* … */
      });

      started = true;

      // 4) teardown を「戻り値」で返す（LIFO で destroy 時に呼ばれる）
      return () => {
        off();
        unregister();
        started = false;
      };
    },
  };
}
```

## barrel（`src/index.ts`）

`src/index.ts` は1行の barrel にする。ESM/NodeNext 解決のため import は `.js` 拡張子。

```ts
// src/index.ts
export { createExamplePlugin } from "./plugin.js";
```

## package.json の型

依存は `@edv4h/russell-shared`（契約・ドメイン型）、`@edv4h/russell-core` は peer にする。装備プラグインなど MCP を使うものは `@edv4h/russell-mcp-helpers` を足してよい。

```json
{
  "name": "@edv4h/russell-plugin-example",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "source": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "dependencies": {
    "@edv4h/russell-shared": "workspace:*"
  },
  "peerDependencies": { "@edv4h/russell-core": "workspace:*" }
}
```

外注・サードパーティは `@edv4h/russell-shared` の契約にだけ依存して独立に publish でき、ホスト（`apps/agent`）が配列に足すだけで組み込める。パッケージ全体像は [`../reference/33-package-layout.md`](../reference/33-package-layout.md)。

## ファイル・命名規約

- パッケージ名: `@edv4h/russell-plugin-{kind}-{name}`（`kind` = `surface` / `equipment` / `memory` / `finding` / `habit` / `model`）。`kind` はコードで強制されない（契約に種別フィールドが無い）＝あくまで人間向けの整理。
- ファイルは **kebab-case**（`plugin.ts`, `shapes/hexagon.ts` のように）。
- ファクトリは `createXxxPlugin()` を **named export**（default export にしない）。
- `id` はパッケージ名から `@edv4h/` を除いた文字列に揃える。

## 自己分類 — どのレジストリに触れるか

「何のプラグインか」は register 先で決まる。触れてよいレジストリは複数でもよい。

| 触れるレジストリ | それは何のプラグインか | 専用ガイド |
|---|---|---|
| `ctx.surfaces.register(...)` | 通信面（Slack/CLI/Web） | [21](./21-authoring-a-surface.md) |
| `ctx.equipment.register(...)` + `ctx.policy.declareEffect(...)` | 装備（MCP） | [22](./22-authoring-equipment.md) |
| `ctx.findings.register(...)` | 気づき種別 | [23](./23-authoring-a-finding.md) |
| `ctx.services.provide('memory', …)` + `ctx.tools.register(...)` | 記憶 capability | — |
| `ctx.routines.register(...)` | 習慣（dispatcher が claim） | — |
| `ctx.models.register(...)` | LLM プロバイダ | — |

1プラグインが複数レジストリに触れてよい。例: `memory-pg` は `ctx.services.provide('memory', …)` と `ctx.tools.register('note.write', …)` の両方を呼ぶ。

## 配列順・順序制約（load-bearing）

`setup` は**配列順に逐次実行**され、イベントバスは**リプレイしない**。したがって配列の並びが意味を持つ:

- **provider は consumer より前**に置く。`services.provide` は同期的な rendezvous なので、`services.get` する側は提供元より後でなければ `undefined` を掴む。
- **emit 側は購読側より前**。`surface-*` が emit する `surface:message` を購読する `finding-*` は、surface より後に setup する（過去の emit は届かない）。
- **コア（Policy Gate 原値）が最初**に確立され、その上に `equipment-*` が効果分類を申告する。

推奨並び順の目安: `services/memory → models → equipment → surfaces → routines → findings`。詳細な順序表は [`../reference/31-core-api.md`](../reference/31-core-api.md#配列順の規約load-bearing) を参照。

destroy 時は収集された teardown が **LIFO** で実行される（後に setup したものから片付く）ので、上記の依存順は破棄時にも自然に守られる。
