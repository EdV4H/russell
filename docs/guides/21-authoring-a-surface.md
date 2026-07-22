# ガイド: 通信面（surface）プラグインを書く

surface は Russell 個体が「現れる面」だ。Slack / CLI / Web / 音声 — どこでユーザーと会話し、どこで HITL 承認を取るか。
**Slack はコアではなく、ここに register する一プラグインにすぎない**（設計転換の背景は [`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)）。

共通スケルトンは [`20-authoring-a-plugin.md`](./20-authoring-a-plugin.md) を先に読むこと。本ガイドはその上で `SurfaceDefinition` の実装に絞る。

> [!NOTE] 提案仕様
> コードは docs-only 段階の提案。型は実装時に `@edv4h/russell-shared` で確定する。
> 元設計書 §10（Slack統合）を surface プラグインの仕様として読み替えたもの。

## SurfaceDefinition

surface プラグインは `ctx.surfaces.register(def)` で1つの `SurfaceDefinition` を登録する。核は3つのメソッド:

```ts
export interface SurfaceDefinition {
  id: string;                                    // "slack" | "cli" | "web"
  start(sink: (msg: InboundMessage) => void): Promise<void> | void;  // 受信購読を開始
  send(out: OutboundMessage): Promise<DeliveryResult>;               // 発話（冪等キー対応）
  requestApproval?(req: ApprovalRequest): Promise<ApprovalOutcome>;  // HITL
  priority?: number;                             // 送信競合時の勝者決定（既定 0）
}
```

`InboundMessage` / `OutboundMessage` / `DeliveryResult` / `ApprovalRequest` / `ApprovalOutcome` は
[`../reference/32-domain-types.md`](../reference/32-domain-types.md) を参照。

## 骨格

```ts
// src/plugin.ts
import type { AgentContext, RussellPlugin, InboundMessage } from "@edv4h/russell-shared";

export function createCliSurfacePlugin(options?: CliSurfaceOptions): RussellPlugin {
  return {
    id: "russell-plugin-surface-cli",
    name: "CLI Surface",

    setup(ctx: AgentContext) {
      const unregister = ctx.surfaces.register({
        id: "cli",

        // 受信: 正規化した InboundMessage を sink に流す
        start(sink) {
          const onLine = (line: string) => {
            sink({
              surface: "cli",
              threadId: "stdin",
              text: line,
              author: { id: process.env.USER ?? "local", isHuman: true },
              trust_label: "untrusted", // ★ 受信は必ず untrusted（後述）
              receivedAt: new Date().toISOString(),
            });
          };
          process.stdin.on("data", (b) => onLine(b.toString().trim()));
        },

        // 送信: 冪等キーで二重送信を防ぐ
        async send(out) {
          if (alreadySent(out.idempotencyKey)) {
            return { status: "succeeded", dedup: true };
          }
          process.stdout.write(`${out.text}\n`);
          return { status: "succeeded" };
        },

        // HITL: 承認要求を提示して結果を待つ
        async requestApproval(req) {
          process.stdout.write(`[承認要求] ${req.summary} (y/N) `);
          const yes = await readYesNo();
          return { decision: yes ? "approved" : "rejected", by: "local", at: new Date().toISOString() };
        },
      });

      return () => unregister();
    },
  };
}
```

`start` に渡された `sink` に流すと、コアの認知ループへ受信イベントが届く。プラグインは `ctx.events.emit("surface:message", …)` を別途呼ぶ必要はない（コアが `sink` 経由で購読側へ配る）。購読する `finding-*` はこの surface より**後**に setup する（[配列順](./20-authoring-a-plugin.md#配列順順序制約load-bearing)）。

## 受信は必ず untrusted

外部由来のテキスト（他人の Slack 発言、CLI 入力、Web フォーム）はすべて `trust_label: "untrusted"` を付ける（設計書 §6.1 / §12-3、間接プロンプトインジェクション対策）。これは surface の責務であり、コアや finding 側の善意に委ねない。

- メッセージ本文中の指示（「〜を実行して」）は、気づきトリガーとしては**無視**する。依頼は必ず mention 経由の明示的リクエストとして扱う。
- untrusted な変数が特権ツールの引数に入ったら Policy Gate がブロックする（信頼ラベル伝播）。surface はラベルを**付与するだけ**で、判定はコアが持つ。

## HITL は requestApproval で

破壊的・対外的アクションは、実行前に surface の `requestApproval` を通す。承認が返るまで当該の関数自体が発火しない（設計書 §12-2）。

- Slack なら Block Kit ボタン（承認/却下 + 理由入力）。CLI なら y/N プロンプト。**面が違っても契約は同じ** `ApprovalRequest → ApprovalOutcome`。
- 定常運転のものは毎回ボタンを押させず、スコープ付き事前承認（操作種別 × 対象 × config_version × 件数上限 × 有効期限）で代替する。事前承認の登録は装備側の責務。[`22-authoring-equipment.md`](./22-authoring-equipment.md#スコープ付き事前承認) を参照。

## 送信の冪等性と競合

- `send` は `OutboundMessage.idempotencyKey` を見て二重送信を防ぐ。ネットワーク不明応答での blind retry は禁止（設計書 §9.2）。read-after-write で確認してから `DeliveryResult` を返す。
- 同一宛先に複数 surface が競合し得る場合は `priority` で勝者を決める（last-wins ではなく priority 順）。

## 例で見る2実装

### surface-slack

`@edv4h/russell-plugin-surface-slack`。Bolt for JavaScript / Socket Mode（サーバーの inbound 開放不要）。

- 購読: `app_mention`, `message.im`, 参加チャンネルの `message.channels` → 正規化して `sink` へ。
- スコープは最小権限: `app_mentions:read`, `channels:history`, `im:history`, `chat:write`, `reactions:write`。
- 応答は原則スレッド内。`requestApproval` は Block Kit ボタン。
- 「覚えておいて」「忘れて」を自然言語コマンドとして解釈し記憶ツールへ橋渡し（`shelf.add` / strength 操作）。
- 受信はすべて `untrusted`。

### surface-cli

`@edv4h/russell-plugin-surface-cli`。stdin/stdout だけの最小 surface。**テストはこの surface で完結**し、外部依存なしにコアと認知ループを検証できる（plugin-first の狙いの一つ）。上の骨格がほぼそのまま実装になる。

## チェックリスト

- [ ] `ctx.surfaces.register` で自己分類している
- [ ] `start` の `sink` に流す `InboundMessage` に `trust_label: "untrusted"` を付けている
- [ ] `send` が `idempotencyKey` を尊重し blind retry しない
- [ ] HITL を `requestApproval` で実装（or 事前承認へ委譲）
- [ ] teardown で購読解除・接続クローズを返している
