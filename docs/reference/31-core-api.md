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

1. レジストリ群を生成（surfaces / equipment / tools / memory / routines / findings / models / policy / audit / events / services）
2. `AgentContext` を組み立て、`runtime`（configVersion pin・mode・killSwitch 別経路）を注入
3. **監査ログを立て**（§3.1）、その上に **Policy Gate 原値を確立**（未登録=deny・killswitch最優先・fail-closed）
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

## 監査ログ（event_log, §3.1）

コアは**全アクションを `ctx.audit` に記録する**（横断必須ゲート）。記録するのはコアであり、
プラグインは永続化先（`AuditSink`）を提供する側に回る（契約は [`30-russell-plugin-contract.md`](./30-russell-plugin-contract.md#auditregistry--監査ログevent_log)）。

| action | actor | trust_label | いつ |
|---|---|---|---|
| `agent.started` / `agent.stopped` | agentId | trusted | 起動・停止（mode・plugin 構成を残す） |
| `turn.received` | 発言者 | 受信メッセージのラベル | mention 受信時 |
| `tool.invoked` / `tool.failed` | agentId | 起因した入力のラベル | Policy Gate 通過後・実行の**前** |
| `policy.denied` | agentId | 起因した入力のラベル | Gate が拒否（`reason` に理由コード） |
| `model.requested` | agentId | 起因した入力のラベル | モデル呼び出しの**前**（外部 I/O・課金対象のため） |
| `model.completed` | agentId | 起因した入力のラベル | モデル応答生成後 |
| `surface.send` | agentId | trusted | 送信の**前** |
| `surface.send.result` | agentId | trusted | 送信結果が `succeeded` 以外（`rejected` / `unknown`）だったとき |
| `turn.failed` | agentId | 起因した入力のラベル | ターンが例外で落ちた |
| `mode.changed` | agentId | trusted | off/dryrun/live の変更の**前**（記録できなければ切り替えない, §6.1） |

原則:

- **記録は行為の前**。監査が残らないまま副作用だけ起きる窓を作らない。
  `record()` は**記録が残ったか**を返す。false（sink 全滅）なら対応する行為を中止する。
  事前の `healthy()` だけでは、その記録自体が最初の失敗だったケースを取りこぼす。
  対象は**外部 I/O 全部**: ツール実行・モデル呼び出し・応答送信。`turn.received` が残せなければ
  ターンごと中止する（以降にモデル呼び出しがあるため）。
- **payload に本文を入れない**（機微情報を監査へ流さない, A1-5）。識別子・件数・長さのみ。
- **来歴を保存**（§12-3）。untrusted 起因のアクションは untrusted のまま残す。
- **fail-closed**（§12-7）。sink が全滅したら `audit.healthy()` が false になり、
  Policy Gate は `read` 以外を deny、認知ループは応答送信も止める。復旧すれば自動で再開。

## エラーとフォールバック

- write 系ツールは実行前に `preflight`。非対応・権限不足は「手動操作の案内」へ段階的縮退（機能全滅にしない）。
- `OperationResult=unknown`（timeout 等）の blind retry は禁止。idempotency key + read-after-write で解決。

関連：[`30-russell-plugin-contract.md`](./30-russell-plugin-contract.md), [`../concepts/15-policy-gate-and-security.md`](../concepts/15-policy-gate-and-security.md)
