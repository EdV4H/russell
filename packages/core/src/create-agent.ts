/**
 * @edv4h/russell-core — カーネル。
 * 出典: docs/reference/31-core-api.md。usketch の packages/core/src/create-app.ts が手本。
 *
 * createAgent は:
 *  1. 直交レジストリ群を生成し AgentContext に束ねる
 *  2. Policy Gate 原値を確立する（default-deny / killswitch最優先 / fail-closed）
 *  3. plugins を配列順に setup(ctx) 実行、teardown を収集
 *  4. いずれかの setup が throw したら収集済み teardown を巻き戻す（部分初期化を残さない）
 *  5. destroy() で teardown を LIFO 実行
 *
 * ※ 認知ループ本体（記憶読出し→文脈構築→モデル→ツール実行→記憶書込み）は P0 の実装対象。
 *   本ファイルはその足場（レジストリ・ライフサイクル・Policy原値）まで。
 */

import type {
  AgentContext,
  AgentRuntime,
  EffectClass,
  EquipmentDefinition,
  EquipmentRegistry,
  EventBus,
  FindingKindDefinition,
  FindingRegistry,
  InboundMessage,
  MemoryCapability,
  Mode,
  ModelProvider,
  ModelRegistry,
  PolicyRegistry,
  RoutineDefinition,
  RoutineRegistry,
  RussellPlugin,
  RussellTeardown,
  ScopedPreApproval,
  ServiceRegistry,
  SurfaceDefinition,
  SurfaceRegistry,
  Temperament,
  ToolRegistry,
  ToolSpec,
} from "@edv4h/russell-shared";
import { MEMORY_SERVICE } from "@edv4h/russell-shared";

export interface AgentConfig {
  agentId: string;
  configVersion: string;
  temperament: Temperament;
  mode?: Mode;
  /** 会話に使うモデルの id（models レジストリに登録された provider）。未指定なら最初に登録されたもの。 */
  model?: string;
}

export interface AgentHandle {
  ctx: AgentContext;
  destroy(): Promise<void>;
}

/** id 付き定義を Map で持つ汎用レジストリ。register は unregister を返す。 */
function createIdRegistry<T extends { id: string }>() {
  const map = new Map<string, T>();
  return {
    register(def: T): () => void {
      map.set(def.id, def);
      return () => map.delete(def.id);
    },
    get: (id: string) => map.get(id),
    getAll: () => [...map.values()],
  };
}

function createEventBus(): EventBus {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on<T>(event: string, handler: (payload: T) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (p: unknown) => void);
      handlers.set(event, set);
      return () => set.delete(handler as (p: unknown) => void);
    },
    emit<T>(event: string, payload: T) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
}

function createServiceRegistry(): ServiceRegistry {
  const map = new Map<string, unknown>();
  return {
    provide<T>(key: string, service: T) {
      map.set(key, service);
    },
    get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    has: (key: string) => map.has(key),
  };
}

/**
 * Policy Gate の決定論的原値。
 * - 効果分類が未申告のツールは default deny。
 * - killswitch が最優先（true なら全 external を遮断）。
 * - fail-closed: 判定に必要な情報が無ければ deny 側へ倒す。
 * 個々の効果分類・事前承認はプラグインが申告するが、この下限はコアが強制する。
 */
function createPolicyGate(runtime: AgentRuntime) {
  const effects = new Map<string, EffectClass>();
  const preApprovals: ScopedPreApproval[] = [];

  const registry: PolicyRegistry = {
    declareEffect(toolName, effect) {
      effects.set(toolName, effect);
    },
    registerPreApproval(grant) {
      preApprovals.push(grant);
      return () => {
        const i = preApprovals.indexOf(grant);
        if (i >= 0) preApprovals.splice(i, 1);
      };
    },
  };

  /** ツール実行前にコアが必ず通す判定。P0 では read/internal_write のみ自動許可。 */
  function isAllowed(toolName: string): boolean {
    if (runtime.killSwitch()) return false; // killswitch 最優先
    const effect = effects.get(toolName);
    if (!effect) return false; // 未申告 = default deny（fail-closed）
    if (effect === "read" || effect === "internal_write") return true;
    // external_* / irreversible_write は HITL or スコープ付き事前承認が要る（P2 以降で実装）
    // TODO(P0-横断ゲート): 事前承認/HITL の突き合わせを実装。現状は安全側=deny。
    return false;
  }

  return { registry, isAllowed };
}

export async function createAgent(
  config: AgentConfig,
  plugins: RussellPlugin[],
): Promise<AgentHandle> {
  // 1. レジストリ生成
  const surfaces = createIdRegistry<SurfaceDefinition>() satisfies SurfaceRegistry;
  const equipment = createIdRegistry<EquipmentDefinition>() satisfies EquipmentRegistry;
  const routinesReg = createIdRegistry<RoutineDefinition>();
  const routines: RoutineRegistry = {
    register: routinesReg.register,
    getAll: routinesReg.getAll,
  };
  const findingsMap = new Map<string, FindingKindDefinition>();
  const findings: FindingRegistry = {
    register(k) {
      findingsMap.set(k.kind, k);
      return () => findingsMap.delete(k.kind);
    },
    getAll: () => [...findingsMap.values()],
  };
  const toolsMap = new Map<string, ToolSpec>();
  const tools: ToolRegistry = {
    register(name, tool) {
      toolsMap.set(name, tool);
      return () => toolsMap.delete(name);
    },
    get: (name) => toolsMap.get(name),
    getAll: () => [...toolsMap.values()],
  };
  const modelsMap = new Map<string, ModelProvider>();
  const models: ModelRegistry = {
    register(m) {
      modelsMap.set(m.id, m);
      return () => modelsMap.delete(m.id);
    },
    get: (id) => modelsMap.get(id),
  };
  const memoryMap = new Map<string, unknown>();
  const memory = {
    register(name: string, capability: unknown) {
      memoryMap.set(name, capability);
      return () => memoryMap.delete(name);
    },
    get: (name: string) => memoryMap.get(name),
  };
  const events = createEventBus();
  const services = createServiceRegistry();

  let currentMode: Mode = config.mode ?? "dryrun";
  const runtime: AgentRuntime = {
    agentId: config.agentId,
    configVersion: config.configVersion,
    mode: () => currentMode,
    // fail-closed の別経路: DB を読めなくても効く env フラグ（docs: kill-switch.md）
    killSwitch: () => process.env.RUSSELL_KILL === "1",
  };

  // 2. Policy Gate 原値
  const policyGate = createPolicyGate(runtime);

  const ctx: AgentContext = {
    surfaces,
    equipment,
    tools,
    memory,
    routines,
    findings,
    models,
    policy: policyGate.registry,
    events,
    services,
    runtime,
  };
  // biome-ignore lint/suspicious/noExplicitAny: mode 変更口はコア内部用（/russell config 経由で差し替え）。
  (ctx as any).__setMode = (m: Mode) => {
    currentMode = m;
    events.emit("mode:changed", m);
  };

  // 3-4. プラグインを順に setup、teardown 収集、失敗時ロールバック
  const teardowns: RussellTeardown[] = [];
  try {
    for (const plugin of plugins) {
      const t = await plugin.setup(ctx);
      if (typeof t === "function") teardowns.push(t);
    }
  } catch (err) {
    for (const t of teardowns.reverse()) await t();
    throw err;
  }

  // --- 認知ループ（§3.2/§3.3/§10）。P0 の心臓部。 ---

  /** temperament から人格プロンプトを生成する（§6.1）。 */
  function personaPrompt(): string {
    const t = config.temperament;
    const back = t.backstory ? ` 背景: ${t.backstory}。` : "";
    return `あなたは「${t.name}」という名前の同僚です。口調: ${t.tone}。${back}記憶を頼りに、簡潔に応答してください。`;
  }

  /** ツール実行は必ず Policy Gate を通す（未申告=deny / killswitch最優先 / external は要承認）。 */
  async function invokeTool(name: string, input: unknown): Promise<unknown> {
    if (!policyGate.isAllowed(name)) {
      events.emit("policy:blocked", { tool: name });
      throw new Error(`policy: tool "${name}" is not allowed`);
    }
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool "${name}" not registered`);
    // biome-ignore lint/suspicious/noExplicitAny: ツール入力は各ツールのスキーマに委ねる（提案骨格）。
    return tool.run(input as any);
  }

  /** 「覚えておいて」「メモして」を自然言語コマンドとして解釈する（§10）。 */
  async function handleMemoryCommands(msg: InboundMessage): Promise<string | undefined> {
    if (/覚え(て|ておいて)|おぼえて/.test(msg.text)) {
      await invokeTool("shelf.add", { source: msg.contextId, card: msg.text });
      events.emit("memory:shelved", { contextId: msg.contextId });
      return "覚えておきますね。";
    }
    if (/メモ(して|しといて)?/.test(msg.text)) {
      await invokeTool("note.write", { contextId: msg.contextId, content: msg.text });
      return "ちょっとメモしますね。";
    }
    return undefined;
  }

  const modelId = config.model ?? [...modelsMap.keys()][0];

  /** 1 ターン: 記憶読出し→文脈構築→モデル→応答→（記憶書込みはツール経由）。 */
  async function handleInbound(msg: InboundMessage): Promise<void> {
    if (runtime.killSwitch()) return; // fail-closed: 凍結中は何もしない
    // P0 は mention のみ応答（自発性なし）
    if (!msg.isMention) return;

    // 自然言語の記憶コマンドを先に処理
    const memAck = await handleMemoryCommands(msg);

    // 記憶読出し（§3.2）
    const mem = services.get<MemoryCapability>(MEMORY_SERVICE);
    const recalled = mem ? await mem.recall(msg.contextId) : { notes: [], books: [] };

    // 文脈構築
    const memoryBlock = [
      recalled.notes.length ? `メモ:\n- ${recalled.notes.join("\n- ")}` : "",
      recalled.books.length
        ? `本棚:\n- ${recalled.books.map((b) => `${b.title}: ${b.card}`).join("\n- ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const system = `${personaPrompt()}\n${memoryBlock}`;

    // モデル呼び出し（provider はプラグイン）
    const provider = modelId ? models.get(modelId) : undefined;
    const replyText = provider
      ? (await provider.complete({ system, user: msg.text })).text
      : "（モデル未登録のため応答できません）";

    // 応答（受信元 surface へ返す）
    const surface = surfaces.get(msg.surfaceId);
    const text = memAck ? `${memAck} ${replyText}` : replyText;
    if (surface) await surface.send({ contextId: msg.contextId, text });
  }

  // surfaces を購読して認知ループを起動。
  // 同一 context（スレッド）のターンは直列化する（記憶の読み書き順を保つ）。
  const turnQueues = new Map<string, Promise<void>>();
  for (const surface of surfaces.getAll()) {
    await surface.start((msg) => {
      const prev = turnQueues.get(msg.contextId) ?? Promise.resolve();
      const next = prev
        .then(() => handleInbound(msg))
        .catch((err) => events.emit("turn:error", err));
      turnQueues.set(msg.contextId, next);
    });
  }

  return {
    ctx,
    async destroy() {
      for (const t of [...teardowns].reverse()) await t();
    },
  };
}
