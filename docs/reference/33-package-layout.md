# リファレンス: パッケージ構成（提案）

> [!NOTE]
> docs-only 段階の**提案**。実際のコードは未作成。実装時は usketch と同じ pnpm + Turborepo モノレポにする想定。
> npm 公開前提のためスコープは `@edv4h/ryo-*`（usketch の `@edv4h/usketch-*` と同系）。

## モノレポ構成（将来像）

```
ryo/                                   # このリポジトリ
├── package.json                       # ルート（private, workspaces）
├── pnpm-workspace.yaml                # packages/* plugins/* examples/* apps/*
├── turbo.json                         # dev/build/test/typecheck パイプライン
├── biome.json / tsconfig.base.json
├── docs/                              # ← 現状はここだけ存在（準備リポ）
├── packages/
│   ├── core/                          # @edv4h/ryo-core   … カーネル createAgent + レジストリ
│   ├── shared/                        # @edv4h/ryo-shared … RyoPlugin/AgentContext/ドメイン型
│   ├── store/                         # @edv4h/ryo-store  … 個体実行状態・config_version（任意）
│   └── mcp-helpers/                   # 装備プラグイン共通の MCP 接続ヘルパ（任意）
├── plugins/
│   ├── ryo-plugin-surface-slack/      # @edv4h/ryo-plugin-surface-slack
│   ├── ryo-plugin-surface-cli/
│   ├── ryo-plugin-memory-pg/
│   ├── ryo-plugin-equipment-github/
│   ├── ryo-plugin-equipment-notion/
│   ├── ryo-plugin-equipment-terminal/
│   ├── ryo-plugin-finding-deadline-risk/
│   ├── ryo-plugin-finding-platform-bug/   # セルフイシュー（§6.4）
│   ├── ryo-plugin-habit-morning/
│   └── ryo-plugin-model-claude/
├── examples/
│   └── ryo-plugin-acme-equipment/     # 外注/サードパーティ用テンプレート
└── apps/
    ├── agent/                         # 個体を組み立てて createAgent する実行ホスト（app + worker）
    └── docs/                          # Starlight ドキュメントサイト（将来）
```

## パッケージの役割

| パッケージ | 役割 | 依存 |
|---|---|---|
| `@edv4h/ryo-core` | カーネル。`createAgent` + 全レジストリ実装 + 認知ループ + Policy Gate原値 | `ryo-shared` のみ |
| `@edv4h/ryo-shared` | プラグイン契約・`AgentContext`・ドメイン型（Finding/Equipment/EffectClass/…）。全プラグインが import | ランタイム依存ほぼ無し |
| `@edv4h/ryo-plugin-*` | 各機能。`createXxxPlugin()` を named export | `ryo-shared`（+ 必要なら `ryo-core`/helpers） |
| `apps/agent` | プリセット→プラグイン配列→`createAgent` の組み立て（usketch の `apps/web/app.tsx` 相当） | 全プラグイン |

## プラグイン package.json の型（提案）

```json
{
  "name": "@edv4h/ryo-plugin-surface-slack",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "source": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "dependencies": {
    "@edv4h/ryo-shared": "workspace:*"
  },
  "peerDependencies": { "@edv4h/ryo-core": "workspace:*" }
}
```

- 各プラグインの `src/index.ts` は1行の barrel（`export { createSlackSurfacePlugin } from "./plugin.js";`）。
- ファイルは kebab-case、ESM/NodeNext 解決のため import は `.js` 拡張子。
- 外注・サードパーティは `@edv4h/ryo-shared` の契約にだけ依存して独立パッケージを publish でき、ホスト（`apps/agent`）が配列に足すだけで組み込める。

## 命名規約

`@edv4h/ryo-plugin-{kind}-{name}`。kind は `surface` / `equipment` / `memory` / `finding` / `habit` / `model`。
kind はコードで強制されない（契約に種別フィールドが無い）＝あくまで人間向けの整理。

関連：[`../concepts/10-plugin-architecture.md`](../concepts/10-plugin-architecture.md), [`30-ryo-plugin-contract.md`](./30-ryo-plugin-contract.md)
