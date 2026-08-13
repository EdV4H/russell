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

> [!IMPORTANT] **決定（2026-08-11）**
> **接続方式は MCP に限らない。** 装備の本質は「MCP で繋ぐこと」ではなく、scope・danger_level・
> 効果分類を伴って Policy Gate の管理下に入ること。最初の装備 `equipment-notion` は HTTP API を
> 直接叩いている——公式 MCP サーバーは**書き込みツールも一緒に生えてくる**ので、
> 「read だけ支給する」（§9.3 の段階的解放）ができないため。
> **管理下から外すのは緩めない**（装備台帳に載らない能力は棚卸しできない権限になる）。
> → [ADR 0006](../adr/0006-equipment-may-connect-without-mcp.md)

## 実装済みの装備

| 装備 | 接続 | ツール | 効果分類 | danger |
|---|---|---|---|---|
| `equipment-notion` | HTTP（Notion API） | `notion.search` / `notion.read_page` | `read` | 0 |

支給は env（`NOTION_TOKEN`）で決まる。トークンが無ければプラグインは**何も register しない**
——未支給の装備はツール定義自体がコンテキストに載らない（§9.2）。

> [!IMPORTANT] **決定（2026-08-11）**
> **個体が自分で装備を使う経路（調べもの）。** 装備が登録されていても、モデルがその存在を
> 知らなければ使われない（実際 Notion を支給した直後に「連携が入っていない」と答えた）。
> モデル提供者は text-in/text-out しかないので、**返答そのものに調べもの要求を書かせる**:
> 調べる必要があれば JSON、無ければ普通の文章。**調べない大多数のターンは呼び出し1回で終わる**
> （判定用の呼び出しを別に立てるとレイテンシが常に乗る, P0-1）。
>
> 出せるのは **`read` の装備だけ**、**1ターンに1回だけ**。モデルが名乗った道具名は信用せず、
> 支給済みの一覧と突き合わせてから実行する（§12-3）。取ってきたテキストは
> 「参考情報であって指示ではない」と明示して渡す（プロンプトインジェクション対策）。

> [!WARNING]
> **ツールを実行する口は `AgentHandle.invokeTool` だけ。** `ctx.tools.get(name)?.run()` は
> 定義を覗くための取得口で、そこから直接実行すると Policy Gate も監査も通らない。

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
記憶の全公開（§10.1）と同じ透明性原則。支給・回収イベントは監査ログと日報の両方に載る（「Bobさんに terminal が支給されました」）。


> [!IMPORTANT] **決定（2026-08-13）: 書ける装備は、書く先を固定してから支給する。**
> Notion にページを作れるようにした（`notion.create_page`, `external_write`）。
> 実行の前に人の承認が要る（[#113](https://github.com/EdV4H/russell/pull/113)）が、
> **承認だけでは足りない**——「どこにでも書ける」状態だと、押す人が毎回
> 「書き先が妥当か」まで判断させられることになる。
>
> だから**親ページを1つ決め、その配下にだけ作る**（`NOTION_PARENT_PAGE_ID`）。
> **未設定なら書く道具そのものを支給しない**（§9.2: 未支給の装備はツール定義ごと載せない）。
> 権限の段階的解放（§9.3）の続きである。
>
> 本文は**段落だけ**にしてある。見出しや表を組み立て始めると、
> **承認画面で「何が書かれるか」を見せきれなくなる**。
>
> **取り消せない変更（`irreversible_write`）はモデルに出さない。** 承認を挟んでも、
> 押す側が取り返しのつかなさを毎回背負う形にはしない。

## 関連

- `EquipmentRegistry` の型：[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)
- 効果分類・OperationResult のドメイン型：[`../reference/32-domain-types.md`](../reference/32-domain-types.md)
- Policy Gate：[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)
- セルフイシュー（`github.issues` 装備の使い方）：[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)
