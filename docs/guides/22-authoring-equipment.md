# ガイド: 装備（equipment / MCP）プラグインを書く

装備は個体が外部システムへ働きかける能力だ。Slack・GitHub・Notion・サンドボックスターミナル — 入社時に PC や社員証を支給されるのと同じく、個体へ**支給**される（設計書 §9）。実装単位は「MCPサーバー1接続 + 権限スコープ + 危険度」のパッケージ。

共通スケルトンは [`20-authoring-a-plugin.md`](./20-authoring-a-plugin.md) を先に。本ガイドは `EquipmentDefinition` と Policy Gate への申告に絞る。

> [!NOTE] 提案仕様
> コードは docs-only 段階の提案。型は実装時に `@edv4h/russell-shared` で確定する。

> [!IMPORTANT] **決定（2026-08-11）**
> **接続は MCP に限らない。** 実装済みの `equipment-notion` は HTTP API を直接叩いている。
> 装備の要件は「MCP で繋ぐこと」ではなく、効果分類の申告・スコープ・danger_level を伴って
> Policy Gate の管理下に入ること。→ [ADR 0006](../adr/0006-equipment-may-connect-without-mcp.md)
>
> 実行は `AgentHandle.invokeTool` を通す。`ctx.tools.get(name)?.run()` は Policy Gate も監査も通らない。

## EquipmentDefinition

装備プラグインは `ctx.equipment.register(def)` で登録し、あわせて各ツールの効果分類を `ctx.policy.declareEffect(...)` へ**申告**する。

```ts
export interface EquipmentDefinition {
  id: string;                          // "github" | "notion" | "terminal"
  mcpServer: McpServerRef;             // 接続先 MCP サーバー定義
  scopes: EquipmentScope[];            // 細分権限（notion read/write を別スコープに）
  dangerLevel: 0 | 1 | 2 | 3;          // 効果分類から導出。2以上は毎回 HITL
  tools(): EquipmentToolSpec[];        // { name, effect: EffectClass, ... }
  preflight?(target: unknown, token: unknown): Promise<PreflightResult>;
}
```

`EffectClass` / `OperationResult` / `EquipmentScope` / `ScopedPreApproval` は
[`../reference/32-domain-types.md`](../reference/32-domain-types.md) を参照。

## 効果分類を宣言する

全ツールに効果分類を付ける（未分類ツール・未知リソースはコアが default deny）。`danger_level` はこれから**導出**する — 手で盛らない。

| EffectClass | 意味 | 導出される danger_level |
|---|---|---|
| `read` | 読み取りのみ | 0 |
| `internal_write` | 自分の記憶・内部状態への書込み | 0–1 |
| `external_write` | 外部システムへの作成/更新 | 2（毎回 HITL） |
| `external_send` | 対外送信（メッセージ・メール） | 2 |
| `irreversible_write` | 不可逆（削除・本番反映） | 3 |

```ts
setup(ctx: AgentContext) {
  const unregister = ctx.equipment.register({
    id: "github",
    mcpServer: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    scopes: [{ kind: "repo", value: "edv4h/russell", access: "issues" }],
    dangerLevel: 2, // external_write から導出
    tools: () => [
      { name: "github.issues.create", effect: "external_write" },
      { name: "github.issues.comment", effect: "external_write" },
      { name: "github.issues.get", effect: "read" },
    ],
  });

  // Policy Gate へ効果分類を申告（判定枠組みと下限はコアが強制）
  ctx.policy.declareEffect("github.issues.create", "external_write");
  ctx.policy.declareEffect("github.issues.comment", "external_write");
  ctx.policy.declareEffect("github.issues.get", "read");

  return () => unregister();
}
```

> コアの原値（未登録=deny / killswitch 最優先 / fail-closed）はこの申告では**緩和できない**。装備は自分の効果分類を申告するだけで、判定と下限はコアが握る（[`../concepts/10-plugin-architecture.md`](../concepts/10-plugin-architecture.md#セキュリティはプラグインに委ねない)）。

## preflight — 書けるか事前に確かめる

write 系ツールは実行前に `preflight` を通す。このトークン・この対象で本当に書けるかの**実行時**検査だ。

```ts
async preflight(target, token) {
  const ok = await canWrite(target, token);
  if (!ok) return { ok: false, reason: "insufficient_scope" };
  return { ok: true };
}
```

非対応・権限不足のときは機能を全滅させず、**手動操作の案内**へ段階的に縮退する（設計書 §9.2）:

> 「Notion への書き込み権限が確認できませんでした。恐れ入りますが、以下の内容を手動で貼り付けていただけますか?（本文プレビュー…）」

## OperationResult — 結果不明を一級で扱う

書き込みの結果は `succeeded / rejected / unknown` の3値。**`unknown`（timeout 等）での blind retry は禁止**（二重投稿・重複作成の防止、設計書 §9.2）。

```ts
const res = await mcp.call("github.issues.create", args);
switch (res.status) {
  case "succeeded":
    return res;
  case "rejected":
    return res; // 明確な拒否。手動案内 or 上位で判断
  case "unknown":
    // ★ 再送しない。idempotency key + read-after-write で突き合わせる
    const found = await readBack(args.idempotencyKey);
    return found ? { status: "succeeded", dedup: true } : { status: "unknown" };
}
```

- **idempotency key** を作成系リクエストに必ず載せる。
- unknown を掴んだら、同じキーで **read-after-write** し、実際に作成されていれば `succeeded`（dedup）として扱う。見つからなければ unknown のまま人間に上げる。

## スコープ付き事前承認

定常運転の `external_write` を毎回ボタン承認させないために、スコープ付き事前承認を登録する。粒度は **操作種別 × 対象 × config_version × 件数上限 × 有効期限**（設計書 §12-2）。

```ts
ctx.policy.registerPreApproval({
  operation: "github.issues.create",
  target: { kind: "repo", value: "edv4h/russell" },
  configVersion: ctx.runtime.configVersion, // この設定版に限定
  limit: { count: 3, per: "week" },          // 例: 3件/週
  expiresAt: "2026-09-30T00:00:00Z",
});
```

上限を超えた分・範囲外の対象は、通常どおり HITL に落ちる。事前承認はあくまで「範囲を厳密に限定した上での自動化」であって、無制限の許可ではない。

## 例: equipment-github（セルフイシュー）

`@edv4h/russell-plugin-equipment-github`。個体が自分の基盤の不具合を自分で GitHub Issue に起票する経路（設計書 §6.4）。装備側の要点:

- **対象は Russell 自身のリポジトリのみに限定支給**（`scopes` を1リポに絞る）。他リポは持たせない。
- 効果分類は `external_write`（danger_level 2）。よって**スコープ付き事前承認（対象リポ × 3件/週）の範囲でのみ自動起票**。それ以外は dryrun（管理チャンネルに下書き提示）から始める。
- 同じ不具合で複数 Issue を立てない: 再発時は新規起票ではなく既存 Issue へコメント追記（`github.issues.comment`）。この dedup 判定は finding 側の `finding_key`（エラーシグネチャのハッシュ）が担う → [`23-authoring-a-finding.md`](./23-authoring-a-finding.md)。
- ループガード: 起票機能自体の不具合で Issue が暴発しないよう circuit breaker 対象。untrusted 由来テキスト（Slack 発言）を根拠にした自動起票は禁止（自動経路は内部テレメトリのみ）。

装備は「起票する能力」を提供し、「何を・いつ起票するか」の判断は finding プラグインが持つ、という分離になる。装備台帳の全体像は [`../preparation/initial-data/equipment-ledger.md`](../preparation/initial-data/equipment-ledger.md) を参照。

## チェックリスト

- [ ] `ctx.equipment.register` + 全ツールの `ctx.policy.declareEffect`
- [ ] `dangerLevel` を効果分類から導出（手で盛らない）
- [ ] write 系に `preflight`、失敗時は手動操作の案内へ縮退
- [ ] `OperationResult=unknown` で blind retry しない（idempotency key + read-after-write）
- [ ] 定常運転は `registerPreApproval` で範囲限定、超過分は HITL
- [ ] `scopes` は最小権限（対象を絞る）
