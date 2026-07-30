# リファレンス: RussellPlugin 契約と AgentContext

> [!NOTE]
> これは **提案仕様**（docs-only 段階）。実装時に `@edv4h/russell-shared` の TypeScript 型として確定する。
> usketch の `packages/shared/src/types/plugin.ts` が権威ソースの手本。

## RussellPlugin

```ts
export interface RussellPlugin {
  readonly id: string;   // 一意。パッケージ名に揃える（例 "russell-plugin-surface-slack"）
  readonly name: string; // 人間向け表示名
  setup(ctx: AgentContext): RussellTeardown | void | Promise<RussellTeardown | void>;
}

export type RussellTeardown = () => void | Promise<void>;
```

規約:
- `type`/`kind` は**持たない**。register するレジストリで自己分類する。
- 状態は `setup` 内のクロージャに持つ（プラグインオブジェクトのプロパティに置かない）。
- クリーンアップは `setup` の戻り値で返す。
- 公開は `createXxxPlugin(options?)` ファクトリ（新鮮なインスタンスを返す）。

## AgentContext

```ts
export interface AgentContext {
  surfaces: SurfaceRegistry;
  equipment: EquipmentRegistry;
  tools: ToolRegistry;
  memory: MemoryRegistry;      // capability は services 経由でも取れる
  routines: RoutineRegistry;
  findings: FindingRegistry;
  models: ModelRegistry;
  policy: PolicyRegistry;
  audit: AuditRegistry;        // 監査ログ（event_log, §3.1）。sink はプラグインが登録する
  events: EventBus;
  services: ServiceRegistry;
  // コアが保持し、プラグインは読み取り主体:
  runtime: {
    agentId: string;
    configVersion: string;             // 実行開始時に pin
    mode: () => "off" | "dryrun" | "live";
    killSwitch: () => boolean;         // env/シグナル別経路を含む
  };
}
```

## レジストリ interface（提案）

### SurfaceRegistry — 通信面

```ts
export interface SurfaceDefinition {
  id: string;                          // "slack" | "cli" | "web"
  // 受信: 正規化した受信イベントをコアへ流す購読を開始
  start(sink: (msg: InboundMessage) => void): Promise<void> | void;
  // 送信: スレッド/宛先へ発話。冪等キー対応
  send(out: OutboundMessage): Promise<DeliveryResult>;
  // HITL: 承認要求を提示し結果を待つ（Slackなら Block Kit ボタン）
  requestApproval?(req: ApprovalRequest): Promise<ApprovalOutcome>;
  priority?: number;                   // 送信の競合時の勝者決定（既定 0）
}
export interface SurfaceRegistry {
  register(def: SurfaceDefinition): () => void; // unregister を返す
  get(id: string): SurfaceDefinition | undefined;
  getAll(): SurfaceDefinition[];
}
```

`InboundMessage` は `trust_label: "untrusted"` を既定で付与する（外部由来テキスト。設計書§6.1/§12-3）。

### EquipmentRegistry — 装備（MCP）

```ts
export interface EquipmentDefinition {
  id: string;                          // "github" | "notion" | "terminal"
  mcpServer: McpServerRef;             // 接続先MCPサーバー定義
  scopes: EquipmentScope[];            // 細分権限（notion read/write を別スコープに）
  dangerLevel: 0 | 1 | 2 | 3;          // 効果分類から導出。2以上は毎回HITL
  // 各ツールの効果分類を policy へ申告
  tools(): EquipmentToolSpec[];        // { name, effect: EffectClass, ... }
  preflight?(target: unknown, token: unknown): Promise<PreflightResult>;
}
export interface EquipmentRegistry {
  register(def: EquipmentDefinition): () => void;
  get(id: string): EquipmentDefinition | undefined;
  getAll(): EquipmentDefinition[];
}
```

`EffectClass` / `OperationResult` などは [`32-domain-types.md`](./32-domain-types.md)。

### ToolRegistry / MemoryRegistry / RoutineRegistry / FindingRegistry / ModelRegistry

```ts
export interface ToolRegistry { register(name: string, tool: ToolSpec): () => void; }
export interface MemoryRegistry { /* note/shelf/deep_recall の登録 or capability 公開 */ }
export interface RoutineRegistry { register(r: RoutineDefinition): () => void; } // cron/prompt/origin
export interface FindingRegistry { register(k: FindingKindDefinition): () => void; } // kind/検知器
export interface ModelRegistry { register(m: ModelProvider): () => void; } // haiku/sonnet/opus
```

### PolicyRegistry — Policy Gate 拡張

```ts
export interface PolicyRegistry {
  // 装備/ツールが自分の効果分類を申告（判定枠組みと下限はコアが強制）
  declareEffect(toolName: string, effect: EffectClass): void;
  // スコープ付き事前承認の登録（操作種別×対象×config_version×件数上限×有効期限）
  registerPreApproval(grant: ScopedPreApproval): () => void;
}
```

> コアの原値（未登録=deny / killswitch最優先 / fail-closed）はこのレジストリでは緩和できない。

### AuditRegistry — 監査ログ（event_log）

```ts
export interface AuditRegistry {
  registerSink(sink: AuditSink): () => void;   // 永続化先を登録（audit-pg 等）
  record(event: AuditRecordInput): Promise<void>;
  recent(limit?: number): AuditEvent[];        // 直近のインメモリ分（調査用）
  healthy(): boolean;                          // false = 監査が残せない → fail-closed
}

export interface AuditSink {
  id: string;
  write(event: AuditEvent): Promise<void>;     // 失敗は throw する（握り潰さない）
}
```

- **記録するのはコア**。プラグインは `record()` を呼ぶ必要はなく、永続化先（sink）を提供する側に回る。
- `AuditEvent` は `ts / actor / action / payload / trustLabel / agentId / configVersion`。
- **来歴を失わせない**（§12-3）: untrusted な発言に起因するツール実行は `trustLabel: "untrusted"` のまま残る。
- **payload に本文を入れない**（A1-5）。識別子・件数・長さだけを入れる。
- sink が全滅すると `healthy()` が false になり、Policy Gate が `read` 以外を deny する（§12-7）。
  sink 未登録（オフライン構成）は障害ではないので degraded にはしない。
- 実装: `@edv4h/russell-plugin-audit-pg`（Postgres `event_log`・追記専用をトリガで強制）。

### EventBus / ServiceRegistry

```ts
export interface EventBus {
  on<T = unknown>(event: string, h: (payload: T) => void): () => void; // off を返す
  emit<T = unknown>(event: string, payload: T): void;
}
export interface ServiceRegistry {
  provide<T>(key: string, service: T): void;
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
}
```

既知イベント例（型付き）: `surface:message`, `finding:detected`, `equipment:result`, `routine:fired`, `mode:changed`, `killswitch:engaged`, `policy:blocked`, `audit:degraded` / `audit:recovered`。

## 関連

- ライフサイクル・順序制約：[`31-core-api.md`](./31-core-api.md)
- ドメイン型：[`32-domain-types.md`](./32-domain-types.md)
- パッケージ構成：[`33-package-layout.md`](./33-package-layout.md)
