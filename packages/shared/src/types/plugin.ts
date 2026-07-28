/**
 * Russell プラグイン契約と AgentContext（提案仕様の骨格）。
 * 出典: docs/reference/30-russell-plugin-contract.md。usketch の UsketchPlugin / PluginContext が手本。
 *
 * 原則:
 * - コアは具体機能を一切参照しない。プラグインは「どのレジストリに register するか」で自己分類する。
 * - 契約は { id, name, setup(ctx) } のみ。種別フィールドは持たない。
 * - teardown は setup の戻り値（プロパティに置かない）。
 */

import type {
  ApprovalOutcome,
  ApprovalRequest,
  DeliveryResult,
  EffectClass,
  InboundMessage,
  Mode,
  OutboundMessage,
  ScopedPreApproval,
} from "./domain.js";
import type { ModelRequest, ModelResponse } from "./runtime.js";

export type RussellTeardown = () => void | Promise<void>;

/** すべてのプラグインが実装する唯一の契約。 */
export interface RussellPlugin {
  readonly id: string;
  readonly name: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: teardown-or-nothing は意図した契約（usketch UsketchPlugin と同形）。
  setup(ctx: AgentContext): RussellTeardown | void | Promise<RussellTeardown | void>;
}

/** コアがプラグインに渡すレジストリ群の束。 */
export interface AgentContext {
  surfaces: SurfaceRegistry;
  equipment: EquipmentRegistry;
  tools: ToolRegistry;
  memory: MemoryRegistry;
  routines: RoutineRegistry;
  findings: FindingRegistry;
  models: ModelRegistry;
  policy: PolicyRegistry;
  events: EventBus;
  services: ServiceRegistry;
  /** コアが保持しプラグインは読み取り主体。 */
  runtime: AgentRuntime;
}

export interface AgentRuntime {
  agentId: string;
  configVersion: string;
  mode(): Mode;
  /** DB 障害時にも効く別経路（env/シグナル）を含む。 */
  killSwitch(): boolean;
}

// --- surfaces（通信面。Slack/CLI/Web はここに register する一プラグイン） ---
export interface SurfaceDefinition {
  id: string;
  start(sink: (msg: InboundMessage) => void): Promise<void> | void;
  send(out: OutboundMessage): Promise<DeliveryResult>;
  requestApproval?(req: ApprovalRequest): Promise<ApprovalOutcome>;
  priority?: number;
}
export interface SurfaceRegistry {
  register(def: SurfaceDefinition): () => void;
  get(id: string): SurfaceDefinition | undefined;
  getAll(): SurfaceDefinition[];
}

// --- equipment（装備 = MCP接続 + scope + danger + 効果分類） ---
export interface EquipmentToolSpec {
  name: string;
  effect: EffectClass;
}
export interface EquipmentDefinition {
  id: string;
  mcpServer: unknown; // McpServerRef（実装時に確定）
  scopes: string[];
  dangerLevel: 0 | 1 | 2 | 3;
  tools(): EquipmentToolSpec[];
}
export interface EquipmentRegistry {
  register(def: EquipmentDefinition): () => void;
  get(id: string): EquipmentDefinition | undefined;
  getAll(): EquipmentDefinition[];
}

// --- tools（エージェントが呼べるツール。note.write / shelf.add / deep_recall 等） ---
export interface ToolSpec {
  name: string;
  effect: EffectClass;
  // biome-ignore lint/suspicious/noExplicitAny: 提案骨格。実装時に入出力スキーマを確定する。
  run(input: any): Promise<unknown>;
}
export interface ToolRegistry {
  register(name: string, tool: ToolSpec): () => void;
  get(name: string): ToolSpec | undefined;
  getAll(): ToolSpec[];
}

// --- memory（記憶 capability。memory-pg が services 経由で提供する。詳細は実装時） ---
export interface MemoryRegistry {
  register(name: string, capability: unknown): () => void;
  get(name: string): unknown;
}

// --- routines（習慣。dispatcher が claim する登録簿。P2） ---
export interface RoutineDefinition {
  id: string;
  cron: string;
  prompt: string;
  origin: "builtin" | "learned";
}
export interface RoutineRegistry {
  register(r: RoutineDefinition): () => void;
  getAll(): RoutineDefinition[];
}

// --- findings（気づき種別。kind ごとの検知器。P3） ---
export interface FindingKindDefinition {
  kind: string;
  detect(input: unknown): Promise<unknown>;
}
export interface FindingRegistry {
  register(k: FindingKindDefinition): () => void;
  getAll(): FindingKindDefinition[];
}

// --- models（LLM プロバイダ。Haiku/Sonnet/Opus 選択） ---
export interface ModelProvider {
  id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
export interface ModelRegistry {
  register(m: ModelProvider): () => void;
  get(id: string): ModelProvider | undefined;
}

// --- policy（Policy Gate 拡張。原値=default deny/killswitch/fail-closed はコアが握る） ---
export interface PolicyRegistry {
  /** 装備/ツールが自分の効果分類を申告（判定枠組みと下限はコアが強制）。 */
  declareEffect(toolName: string, effect: EffectClass): void;
  registerPreApproval(grant: ScopedPreApproval): () => void;
}

// --- events（イベントバス。型なしフォールバックで自由にイベント名を発明） ---
export interface EventBus {
  on<T = unknown>(event: string, handler: (payload: T) => void): () => void;
  emit<T = unknown>(event: string, payload: T): void;
}

// --- services（IoC。DB/pgvector・埋め込み・config_version ストア等） ---
export interface ServiceRegistry {
  provide<T>(key: string, service: T): void;
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
}
