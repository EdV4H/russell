# 装備（Equipment）

外部システムへ働きかける能力はすべて「装備」に統一する（設計書
[`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §9）。
Slack・GitHub・Notion・サンドボックスターミナル — 個体が使える道具は、入社時に PC や社員証を支給されるのと同じく**支給される**もの。

装備は plugin-first の**原型**でもある。設計書 §9.1 は既に「MCP サーバーを台帳に登録するだけで本体コード変更不要」という
事実上のプラグインとして装備を設計していた。plugin-first はこの思想を surface・気づき・習慣・モデルへ一般化しただけ
（[`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)）。

## 装備 = MCP接続 + scope + danger_level + 効果分類（§9.1）

装備1つ = **MCPサーバー1接続 + 権限スコープ + 危険度**のパッケージ。装備プラグインは:

- `ctx.equipment.register(def)` に `EquipmentDefinition` を登録（`mcpServer` / `scopes` / `dangerLevel` / `tools()` / `preflight?`）
- `ctx.policy` へ各ツールの**効果分類**を申告

```ts
// EquipmentDefinition の要点（reference/30）
{ id: "github", mcpServer, scopes, dangerLevel: 0|1|2|3,
  tools(): EquipmentToolSpec[],   // { name, effect: EffectClass }
  preflight?(target, token) }
```

新しい装備の追加＝プラグインを1つ書いて配列に足すだけ。コアのコード変更は不要（MCP の疎結合思想そのまま）。

## 効果分類（§9.2）

全ツールに効果分類を付ける（Frank v2 から採用）。危険度 `danger_level` はここから導出する。

| 効果分類 | 意味 |
|---|---|
| `read` | 読み取りのみ |
| `internal_write` | 内部状態の書き込み（記憶等） |
| `external_write` | 外部システムへの書き込み（Notion 更新・Issue 起票） |
| `external_send` | 対外送信（メッセージ送信・メール） |
| `irreversible_write` | 不可逆な書き込み（削除等） |

> [!IMPORTANT]
> **未分類ツール・未知リソースは default deny。** 装備プラグインは効果分類を `ctx.policy` に**申告**するが、
> 「未登録=deny」「killswitch 最優先」「fail-closed」という原値はコアが強制する（プラグインは緩和できない）。
> 詳細は [`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)。

## 支給台帳（§9.1）

誰にどの装備を支給したかは台帳（`issuances`）で管理する。Policy Gate の allowlist は台帳から**機械的に生成**され、
支給・回収が即、実行境界に反映される。

> [!NOTE]
> **未支給の装備はツール定義自体をコンテキストに載せない**（§9.2）。
> モデルは持っていない装備の存在を知らない。「使うな」とプロンプトで禁止するのではなく、物理的に持っていない
> （Prompt Guardrail Fallacy の回避）。

テーブル定義（`equipment` / `issuances`）は [`19-data-model.md`](./19-data-model.md)。

## preflight と OperationResult（§9.2）

- **preflight** — write 系ツールは実行前に「このトークン・この対象で本当に書けるか」の実行時検査を行う。
  非対応・権限不足は**「手動操作の案内」に段階的縮退**し、機能全滅にしない
- **OperationResult** — 書き込み結果を `succeeded` / `rejected` / `unknown` の一級データで扱う。
  タイムアウト等で `unknown` になった操作の **blind retry は禁止**（二重投稿・重複作成の防止）。
  idempotency key + read-after-write で突き合わせて解決

`terminal` は最危険装備（`danger_level 3`）: サンドボックス VM 限定、全コマンドを `event_log` へ、破壊系コマンドは HITL 必須。

## 習熟度の成長（§9.3）

`proficiency` は装備×個体ごとに育つ（`issuances.proficiency`）。関連 playbook の成功で上昇する。

- **低いうち（新人）** — 使用前の確認質問が増え、HITL 頻度が上がる（レビュー多めの新人と同じ）
- **高くなる（ベテラン）** — 確認をスキップし、HITL 閾値が緩和される（**Policy Gate の決定論的下限は維持**）

段階的な権限解放というセキュリティ要件と、「新人がだんだん仕事を覚える」という人間らしさが、同じ1つの変数で実装される。

## 可視性（§9.4）

個体のプロフィール（Web UI・Slack プロフィール欄）に装備一覧と習熟度を表示する。誰が何をできるかはチーム全員から見える。
記憶の全公開（§10.1）と同じ透明性原則。支給・回収イベントは監査ログと日報の両方に載る（「覚さんに terminal が支給されました」）。

## 関連

- `EquipmentRegistry` の型：[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)
- 効果分類・OperationResult のドメイン型：[`../reference/32-domain-types.md`](../reference/32-domain-types.md)
- Policy Gate：[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)
- セルフイシュー（`github.issues` 装備の使い方）：[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)
