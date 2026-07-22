# リファレンス: コアAPI（createAgent とライフサイクル）

> [!NOTE]
> 提案仕様。実装時に `@edv4h/russell-core` として確定。usketch の `packages/core/src/create-app.ts` が手本。

## createAgent

```ts
export interface AgentConfig {
  agentId: string;
  configVersion: string;               // 公開版。実行開始時に pin される
  temperament: Temperament;            // 設計書§6.1
  mode?: "off" | "dryrun" | "live";    // 既定 "dryrun"
}

export async function createAgent(
  config: AgentConfig,
  plugins: RussellPlugin[],
): Promise<AgentHandle>;

export interface AgentHandle {
  ctx: AgentContext;
  destroy(): Promise<void>;            // teardown を LIFO 実行
}
```

## 起動シーケンス

1. レジストリ群を生成（surfaces / equipment / tools / memory / routines / findings / models / policy / events / services）
2. `AgentContext` を組み立て、`runtime`（configVersion pin・mode・killSwitch 別経路）を注入
3. **Policy Gate 原値を確立**（未登録=deny・killswitch最優先・fail-closed）
4. `plugins` を**配列順に** `await plugin.setup(ctx)`、teardown を収集
5. いずれかの `setup` が throw → 収集済み teardown を巻き戻して失敗（部分初期化を残さない）
6. 認知ループ／dispatcher を起動可能な状態にして `AgentHandle` を返す

## 破棄シーケンス

`destroy()` は収集した teardown を **LIFO** で実行。surface の購読解除・MCP接続クローズ・イベント購読解除など各プラグインの後始末が呼ばれる。

## 配列順の規約（load-bearing）

`setup` は逐次・イベントバスは非リプレイのため、順序が意味を持つ:

| 前に置く | 後に置く | 理由 |
|---|---|---|
| `services` 提供元（`memory-pg` 等） | それを `services.get` する側 | IoC は同期的な rendezvous |
| `surface-*` | `surface:message` を購読する `finding-*` | emit をリプレイしないため |
| コア（Policy原値） | 効果分類を申告する `equipment-*` | 原値の上に申告が乗る |
| `model-*` | モデルを選ぶ認知ループ | プロバイダ未登録だと選べない |

推奨並び順の目安: `services/memory → models → equipment → surfaces → routines → findings`。

## モードとキルスイッチ

- `runtime.mode()` は `off / dryrun / live`。副作用（投稿・書込み）の**直前に再検査**する（設計書§5.1）。
- `runtime.killSwitch()` は DB 障害時にも効く別経路（env フラグ / プロセスシグナル）を含む。engaged なら全自発行動を凍結。
- `dryrun` では Finding 導出・文面生成まで行い、投稿はログ・管理チャンネルのみ（live の dedup 状態を汚さない）。

## エラーとフォールバック

- write 系ツールは実行前に `preflight`。非対応・権限不足は「手動操作の案内」へ段階的縮退（機能全滅にしない）。
- `OperationResult=unknown`（timeout 等）の blind retry は禁止。idempotency key + read-after-write で解決。

関連：[`30-russell-plugin-contract.md`](./30-russell-plugin-contract.md), [`../concepts/15-policy-gate-and-security.md`](../concepts/15-policy-gate-and-security.md)
