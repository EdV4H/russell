/**
 * @edv4h/russell-core — カーネル。
 * 出典: docs/reference/31-core-api.md。usketch の packages/core/src/create-app.ts が手本。
 *
 * createAgent は:
 *  1. 直交レジストリ群を生成し AgentContext に束ねる
 *  2. 監査ログ（event_log, §3.1）を立て、Policy Gate 原値を確立する
 *     （default-deny / killswitch最優先 / fail-closed = 監査が残せないなら副作用を止める）
 *  3. plugins を配列順に setup(ctx) 実行、teardown を収集
 *  4. いずれかの setup が throw したら収集済み teardown を巻き戻す（部分初期化を残さない）
 *  5. 認知ループを surfaces に結線し、destroy() で teardown を LIFO 実行
 *
 * 監査の原則: **全アクションが trust_label 付きで残る**（test-strategy §5 横断必須ゲート）。
 * 記録は行為の前に行い、本文などの機微情報は payload に入れない（識別子と件数だけ）。
 */

import type {
  AgentContext,
  AgentRuntime,
  AuditRegistry,
  ConversationCapability,
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
  ModelTurn,
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
  TrustLabel,
} from "@edv4h/russell-shared";
import { CONVERSATION_SERVICE, MEMORY_SERVICE } from "@edv4h/russell-shared";
import { createAuditLog } from "./audit.js";
import { createFreezeGate } from "./freeze.js";
import {
  NO_MORE_LOOKUP,
  TOOL_DESCRIPTIONS,
  allowedLookup,
  lookupCatalog,
  lookupInstructions,
  parseLookup,
  renderLookupResult,
} from "./lookup.js";
import {
  type MemoryDecision,
  buildDecisionRequest,
  isEmptyDecision,
  parseDecision,
} from "./memory-decision.js";
import { modeAllowsSend, modeAllowsTool, modeSuppressionReason } from "./mode.js";
import {
  type SensitiveCategory,
  type SensitiveGuardConfig,
  inspectSensitive,
} from "./sensitive-guard.js";

/**
 * 凍結中（レベル1/2）に mention へ返す唯一の文。
 * 「今止まってます」を返せる方が親切・状況説明できる、という決定（kill-switch.md 2026-07-23）。
 * モデルを通さない固定文にしているのは、凍結中に生成を走らせないため。
 */
export const FROZEN_NOTICE =
  "いま止まっています（キルスイッチ発動中）。再開は運用担当者の解除を待ってください。";

/** `destroy()` が実行中のターンを待つ上限。これを超えたターンは諦めて片付けに進む。 */
const DRAIN_TIMEOUT_MS = 5_000;

/** 1文脈あたりに保持する発言数（user/assistant 合計）。超えたら古いものから捨てる。 */
const CONTEXT_TURNS = 20;

export interface AgentConfig {
  agentId: string;
  configVersion: string;
  temperament: Temperament;
  mode?: Mode;
  /** 会話に使うモデルの id（models レジストリに登録された provider）。未指定なら最初に登録されたもの。 */
  model?: string;
  /** 記憶の判定に使うモデルの id。未指定なら会話用と同じ。安いモデルに分けられる。 */
  memoryModel?: string;
  /**
   * 機微情報ガード（A-1）。既定は conservative / 全カテゴリ ON（仕様の既定値）。
   * いずれ `config_version.sensitive_guard` から来る値で、形は合わせてある。
   */
  sensitiveGuard?: SensitiveGuardConfig;
  /** 積み残し（返信し忘れ）の拾い直し。 */
  catchup?: CatchupConfig;
}

/**
 * 返信し忘れているやりとりを拾い直す設定。
 *
 * **既定値は保守的にしてある。** 起動のたびに古いスレッドへ返信し始めるのは、
 * 回復ではなく事故に見えるので。
 */
export interface CatchupConfig {
  /** 既定 true。`false` で無効。 */
  enabled?: boolean;
  /** どこまで遡るか。既定12時間。 */
  windowMs?: number;
  /** 1回の確認で返す上限。既定3件。 */
  limit?: number;
  /** 確認の間隔。既定10分。0 で起動時の1回だけ。 */
  intervalMs?: number;
}

/**
 * 1ターンに使える調べものの回数。検索 → 中身を読む、で2手かかるので 1 では足りない。
 * 上げるほど答えは良くなるが、**1手ごとにモデル呼び出しが増える**（P0-1: p95 ≤ 8s）。
 */
const MAX_LOOKUPS_PER_TURN = 3;
/** 調べものに使ってよい時間。歩数が残っていても、これを超えたら答えに向かう。 */
const LOOKUP_DEADLINE_MS = 45_000;

/** 積み残しの確認の既定値。保守側に倒してある（起動のたびに古い話へ返信しないように）。 */
const DEFAULT_CATCHUP_WINDOW_MS = 12 * 60 * 60 * 1000;
const DEFAULT_CATCHUP_LIMIT = 3;
const DEFAULT_CATCHUP_INTERVAL_MS = 10 * 60 * 1000;
/** 同じやりとりを何度まで試すか。失敗が続くと無限に試し続けるのを防ぐ。 */
const MAX_CATCHUP_ATTEMPTS = 2;

export interface AgentHandle {
  ctx: AgentContext;
  /**
   * ツールを **Policy Gate と監査を通して**実行する（§9.2 / §12-7）。
   *
   * コアの外（組み立てホスト・運用コマンド・テスト）から装備を動かすための唯一の入口。
   * これが無いと、装備は登録されているのに誰も呼べない——`deep_recall` がそうなっていた。
   *
   * `ctx.tools.get(name)?.run()` は**使わないこと**。定義を覗くための取得口であって、
   * そこから直接実行すると Policy Gate も監査も通らない。
   *
   * @param trustLabel この実行を引き起こした入力の来歴。他者の発言起因なら `untrusted` のまま渡す（§12-3）。
   */
  invokeTool(name: string, input: unknown, trustLabel?: TrustLabel): Promise<unknown>;
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

/** Policy Gate の判定結果。deny のときは理由コードを持つ（監査に残すため）。 */
type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Policy Gate の決定論的原値。
 * - 効果分類が未申告のツールは default deny。
 * - killswitch が最優先（完全沈黙なら read も含めて全遮断）。
 * - 凍結中（`/russell stop`）は状態を変える行為を止める。read は状態を変えないので通す。
 * - fail-closed: 判定に必要な情報が無ければ deny 側へ倒す。
 *   監査ログが残せない（audit degraded）ときも、read 以外は deny する（§12-7
 *   「承認記録が読めないとき外部送信・書き込みをしない」の書き込み側）。
 * 個々の効果分類・事前承認はプラグインが申告するが、この下限はコアが強制する。
 */
function createPolicyGate(runtime: AgentRuntime, audit: AuditRegistry) {
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

  /**
   * ツール実行前にコアが必ず通す判定。P0 では read/internal_write のみ自動許可。
   * 凍結の再検査を含むので非同期（§5.1「副作用の直前に再検査」）。
   */
  async function decide(toolName: string): Promise<PolicyDecision> {
    const freeze = await runtime.freezeLevel();
    if (freeze === "silent") return { allowed: false, reason: "killswitch" }; // 最優先
    const effect = effects.get(toolName);
    if (!effect) return { allowed: false, reason: "effect_undeclared" }; // default deny
    // 実行モード（§6.5）。**dryrun は外部へ出るものだけ止める**（記憶は書く）。
    // 凍結より後・効果分類より先に見るのは、キルスイッチが常に最優先だから（§12-4）。
    if (!modeAllowsTool(runtime.mode(), effect)) {
      return { allowed: false, reason: modeSuppressionReason(runtime.mode()) };
    }
    if (effect === "read") return { allowed: true };
    // 凍結中（レベル1/2）は状態を変える行為をしない。read だけ残すのは
    // 「最低限の応答は残す」（kill-switch.md 決定 2026-07-23）を成り立たせるため。
    if (freeze === "stopped") return { allowed: false, reason: "stopped" };
    // 監査が残せない状態で副作用を起こさない（fail-closed）。read は状態を変えないので許可。
    if (!audit.healthy()) return { allowed: false, reason: "audit_degraded" };
    if (effect === "internal_write") return { allowed: true };
    // external_* / irreversible_write は HITL or スコープ付き事前承認が要る（P2 以降で実装）
    // TODO(P2): 事前承認/HITL の突き合わせを実装。現状は安全側=deny。
    return { allowed: false, reason: "requires_approval" };
  }

  return { registry, decide };
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
  // 凍結判定（§12-4）。通常経路（/russell stop）は services 越しの capability、
  // 別経路（env）はここで直接見る。詳細は freeze.ts。
  const freezeLevel = createFreezeGate(config.agentId, services, events);
  const runtime: AgentRuntime = {
    agentId: config.agentId,
    configVersion: config.configVersion,
    mode: () => currentMode,
    // fail-closed の別経路: DB を読めなくても効く env フラグ（docs: kill-switch.md）
    killSwitch: () => process.env.RUSSELL_KILL === "1",
    freezeLevel,
  };

  // 2. 監査ログ（§3.1）→ Policy Gate 原値。順序は load-bearing:
  //    Policy Gate は「監査が残せるか」を判定材料にする（fail-closed, §12-7）。
  const auditLog = createAuditLog(runtime, events);
  const policyGate = createPolicyGate(runtime, auditLog.registry);

  const ctx: AgentContext = {
    surfaces,
    equipment,
    tools,
    memory,
    routines,
    findings,
    models,
    policy: policyGate.registry,
    audit: auditLog.registry,
    events,
    services,
    runtime,
  };
  // biome-ignore lint/suspicious/noExplicitAny: mode 変更口はコア内部用（/russell config 経由で差し替え）。
  (ctx as any).__setMode = async (m: Mode): Promise<boolean> => {
    // 設定変更は監査対象（§6.1「変更履歴は event_log へ」）。actor は運用者だが
    // P0 では変更口がコア内部のみなので agentId で記録する。
    // 他の副作用と同じく**記録が残ってから**切り替える。dryrun→live のような昇格が
    // 監査に残らないまま起きると、誰がいつ上げたか追えなくなる（dryrun-to-live-promotion）。
    const from = currentMode;
    if (from === m) return true;
    const audited = await auditLog.registry.record({
      actor: runtime.agentId,
      action: "mode.changed",
      payload: { from, to: m },
      trustLabel: "trusted",
    });
    if (!audited) {
      events.emit("mode:change-blocked", { from, to: m, reason: "audit_degraded" });
      return false;
    }
    currentMode = m;
    events.emit("mode:changed", m);
    return true;
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

  /**
   * 進行中の会話。**記憶ではなく、通信面の文脈**（ADR 0002）。
   *
   * 単位は `contextId` で、それが何を指すかは通信面が決める（Slack はスレッド、
   * DM はチャンネル、CLI はセッション）。**記憶システムの4つのメタファー
   * （メモ帳・日記・本棚・書庫, `12-memory-system.md`）には含めない**——あれは
   * Bob が「保つ」ものの体系で、こちらは「いま抱えている」もの。層が違う。
   *
   * メモ帳（`note.write`）と混ぜないこと。あれは書き留めたものだけが残る記憶で、
   * こちらは何もしなくても残り、何もしなくても消える。会話の全発言をメモ帳に流すと、
   * 夜間バッチが畳む日記が「今日言われた全部」になって壊れる。
   *
   * プロセス内にしか持たない。再起動後は通信面から取り直す（ADR 0001）。
   */
  const conversationContext = new Map<string, ModelTurn[]>();

  function contextTurns(contextId: string): ModelTurn[] {
    // **コピーを返す。** 内部の配列をそのまま渡すと、渡した後の追記でプラグイン側の
    // 手元の履歴が書き換わる（プロバイダが保持していると気づきにくい形で壊れる）。
    return [...(conversationContext.get(contextId) ?? [])];
  }

  /**
   * モデルへ渡す会話。**手元に無ければ通信面から取り直す**（ADR 0001）。
   *
   * 再起動で文脈は消えるが、会話は通信面（Slack 等）に残っている。保存する代わりに
   * 必要になった時点で構成し直す。取れたものは短期記憶に載せるので、2回目以降は叩かない。
   */
  async function conversationFor(msg: InboundMessage): Promise<ModelTurn[]> {
    const buffered = contextTurns(msg.contextId);
    if (buffered.length > 0) return buffered;

    const conversation = services.get<ConversationCapability>(CONVERSATION_SERVICE);
    if (!conversation) return [];
    try {
      const turns = await conversation.history(msg.contextId);
      // 取得物の末尾に今回の発言が含まれることがある（通信面から見れば既に投稿済みなので）。
      // コアは `user` として別に渡すため、そのままだと同じ発言が2回入る。
      const trimmed =
        turns.at(-1)?.role === "user" && turns.at(-1)?.text === msg.text
          ? turns.slice(0, -1)
          : turns;
      if (trimmed.length === 0) return [];
      for (const turn of trimmed) appendTurn(msg.contextId, turn);
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "conversation.recovered",
        payload: { contextId: msg.contextId, turns: trimmed.length },
        trustLabel: msg.trustLabel, // 復元した中身は他者の発言＝untrusted のまま
      });
      return contextTurns(msg.contextId);
    } catch (err) {
      // 取れなくても会話は続ける（流れを踏まえられないだけ）。黙って消さずに残す。
      events.emit("conversation:recover-failed", { contextId: msg.contextId, error: String(err) });
      return [];
    }
  }

  function appendTurn(contextId: string, turn: ModelTurn): void {
    const turns = conversationContext.get(contextId) ?? [];
    turns.push(turn);
    // 古いものから捨てる。無制限に伸ばすとトークンも費用も青天井になる。
    if (turns.length > CONTEXT_TURNS) turns.splice(0, turns.length - CONTEXT_TURNS);
    conversationContext.set(contextId, turns);
  }

  /** temperament から人格プロンプトを生成する（§6.1）。 */
  function personaPrompt(): string {
    const t = config.temperament;
    const back = t.backstory ? ` 背景: ${t.backstory}。` : "";
    // 記憶の扱いについて事実と違うことを言わせない。**これはコード側では保証できない**——
    // 記憶を書くかどうかは会話の後に決まり、返答を書くのはモデルだから、
    // 「できること／できないこと」は人格の一部として渡すしかない（privacy-and-memory-policy §3）。
    const memoryHonesty =
      "記憶について: 忘れるよう言われたとき、実際にできるのは本棚から書庫へ下げることだけで、データは残ります。" +
      "「消しました」とは言わず、書庫に下げたことと、完全な削除は運用担当者を通す必要があることを伝えてください。" +
      "覚えたかどうかを断言せず、できなかったことをできたと言わないでください。" +
      // 実際に何を書き留めるかは**この返答の後**に決まる（ADR 0003）。返答の時点では
      // 1件も書かれていないので、「書いておきました」と実績として語ると必ず嘘になる。
      // 実際、企画書を読んだ回で20語を列挙したが、保存されたのは5件だった。
      "記憶への書き込みは、この返答を送った後に行われます。**何を書き留めたかを列挙しないでください。**" +
      "「書いておきました」ではなく「書き留めておきます」と言い、件数や内訳を断定しないこと。" +
      "何が残ったかは本人が単語帳や本棚を見れば分かります。";
    // 支給されている装備を人格の一部として渡す。**未支給の装備はここに載らない**（§9.2）
    const tools = lookupInstructions(
      lookupCatalog(equipment.getAll(), toolsMap, TOOL_DESCRIPTIONS),
    );
    return `あなたは「${t.name}」という名前の同僚です。口調: ${t.tone}。${back}記憶を頼りに、簡潔に応答してください。\n${memoryHonesty}${tools}`;
  }

  /**
   * ツール実行は必ず Policy Gate を通す（未申告=deny / killswitch最優先 / external は要承認）。
   * 判定結果は許可・拒否どちらも event_log に残す（横断ゲート「全アクションが残る」）。
   *
   * `trustLabel` は**この実行を引き起こした入力の来歴**。他者の Slack 発言起因なら untrusted のまま
   * 記録し、来歴を失わせない（§12-3）。
   */
  async function invokeTool(
    name: string,
    input: unknown,
    trustLabel: TrustLabel,
  ): Promise<unknown> {
    const decision = await policyGate.decide(name);
    if (!decision.allowed) {
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "policy.denied",
        payload: { tool: name, reason: decision.reason },
        trustLabel,
      });
      events.emit("policy:blocked", { tool: name, reason: decision.reason });
      throw new Error(`policy: tool "${name}" is not allowed (${decision.reason})`);
    }
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool "${name}" not registered`);
    // 監査は「行為の前」に残す。落ちても副作用だけが残る窓を作らないため。
    // この記録自体が sink 全滅の初回になることがあるので、decide() の事前判定だけでは足りない。
    const audited = await auditLog.registry.record({
      actor: runtime.agentId,
      action: "tool.invoked",
      payload: { tool: name, effect: tool.effect },
      trustLabel,
    });
    if (!audited) {
      events.emit("policy:blocked", { tool: name, reason: "audit_degraded" });
      throw new Error(`policy: tool "${name}" is not allowed (audit_degraded)`);
    }
    try {
      // biome-ignore lint/suspicious/noExplicitAny: ツール入力は各ツールのスキーマに委ねる（提案骨格）。
      const result = await tool.run(input as any);
      return result;
    } catch (err) {
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "tool.failed",
        payload: { tool: name, error: String(err) },
        trustLabel,
      });
      throw err;
    }
  }

  /**
   * 「メモしました」を発言そのものに可視化する（§10.1 の透明性）。
   * 何で表すかは通信面が決める（Slack なら 📝）。対応しない通信面では何も起きない。
   *
   * 失敗してもターンは続ける。記憶はもう取れていて、これは見え方の問題だから——
   * ただし黙って捨てはせず、結果を監査に残す。
   */
  async function reactNoted(msg: InboundMessage): Promise<void> {
    const surface = surfaces.get(msg.surfaceId);
    if (!surface?.react || !msg.messageId) return;
    // ワークスペースから見える行為なので、他の送信と同じく**記録してから**行う。
    const audited = await auditLog.registry.record({
      actor: runtime.agentId,
      action: "surface.react",
      payload: { surfaceId: msg.surfaceId, contextId: msg.contextId, kind: "noted" },
      trustLabel: "trusted",
    });
    if (!audited) return;
    try {
      const result = await surface.react({
        contextId: msg.contextId,
        messageId: msg.messageId,
        kind: "noted",
      });
      if (result.status !== "succeeded") {
        await auditLog.registry.record({
          actor: runtime.agentId,
          action: "surface.react.result",
          payload: { surfaceId: msg.surfaceId, status: result.status, detail: result.detail },
          trustLabel: "trusted",
        });
      }
    } catch (err) {
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "surface.react.result",
        payload: { surfaceId: msg.surfaceId, status: "unknown", detail: String(err) },
        trustLabel: "trusted",
      });
    }
  }

  /**
   * 何を書き留めるかをモデルに決めさせ、実行する（P0-3/P0-4）。
   *
   * **返答を送った後に走らせる。** 判定を前に置くとモデル呼び出しが2回に増え、
   * 応答レイテンシ（P0-1: p95 ≤ 8s）を返答前に使い切る。人間も、答えてから手帳に書く。
   *
   * 記憶係の不調で会話を壊さない。判定が読めなければ何も書き留めずに終わる。
   */
  async function decideMemory(
    msg: InboundMessage,
    replyText: string,
    readings: string[] = [],
  ): Promise<void> {
    const decider = memoryModelId ? models.get(memoryModelId) : undefined;
    if (!decider) return;
    const mem = services.get<MemoryCapability>(MEMORY_SERVICE);

    let decision: MemoryDecision;
    try {
      const known = mem?.glossary ? await mem.glossary() : [];
      const carrying = mem?.openTodos ? await mem.openTodos() : [];
      const req = buildDecisionRequest(msg.text, replyText, readings, known, carrying);
      decision = parseDecision((await decider.complete(req)).text);
    } catch (err) {
      events.emit("memory:decision-failed", { contextId: msg.contextId, error: String(err) });
      return;
    }
    if (isEmptyDecision(decision)) return;

    // 書き込みは通常どおり Policy Gate と監査を通す。モデルが決めたからといって素通しにしない。
    try {
      if (decision.note) {
        const marks = await markSensitive(decision.note, "note.write", msg);
        await invokeTool(
          "note.write",
          { contextId: msg.contextId, content: decision.note, sensitive: marks },
          msg.trustLabel,
        );
      }
      if (decision.shelf) {
        // 見出しも公開に出るので、本文と一緒に検査する
        const marks = await markSensitive(
          `${decision.shelfTitle ?? ""}\n${decision.shelf}`,
          "shelf.add",
          msg,
        );
        await invokeTool(
          "shelf.add",
          {
            source: msg.contextId,
            card: decision.shelf,
            title: decision.shelfTitle,
            sensitive: marks,
          },
          msg.trustLabel,
        );
        events.emit("memory:shelved", { contextId: msg.contextId });
      }
      if (decision.termOverflow) {
        // 何件落としたかを残す。件数だけで本文は入れない（A1-5）
        await auditLog.registry.record({
          actor: runtime.agentId,
          action: "memory.terms_truncated",
          payload: { contextId: msg.contextId, ...decision.termOverflow },
          trustLabel: msg.trustLabel,
        });
        events.emit("memory:terms-truncated", decision.termOverflow);
      }
      for (const todo of decision.todos ?? []) {
        const marks = await markSensitive(todo.content, "todo.add", msg);
        await invokeTool(
          "todo.add",
          {
            content: todo.content,
            contextId: msg.contextId,
            waitingFor: todo.waitingFor,
            sensitive: marks,
          },
          msg.trustLabel,
        );
        events.emit("todo:added", { contextId: msg.contextId, content: todo.content });
      }
      for (const id of decision.done ?? []) {
        await invokeTool("todo.close", { id, state: "done" }, msg.trustLabel);
        events.emit("todo:closed", { contextId: msg.contextId, id });
      }
      for (const person of decision.people ?? []) {
        const marks = await markSensitive(`${person.name}\n${person.note}`, "person.remember", msg);
        await invokeTool(
          "person.remember",
          {
            name: person.name,
            note: person.note,
            aliases: person.aliases,
            sensitive: marks,
          },
          msg.trustLabel,
        );
        events.emit("memory:person-remembered", { contextId: msg.contextId, name: person.name });
      }
      for (const term of decision.terms ?? []) {
        const marks = await markSensitive(`${term.name}\n${term.definition}`, "term.define", msg);
        await invokeTool(
          "term.define",
          {
            name: term.name,
            definition: term.definition,
            aliases: term.aliases,
            sensitive: marks,
          },
          msg.trustLabel,
        );
        events.emit("memory:term-defined", { contextId: msg.contextId, name: term.name });
      }
      if (decision.forget) {
        const result = (await invokeTool(
          "shelf.forget",
          { query: decision.forget },
          msg.trustLabel,
        )) as { archived?: number };
        events.emit("memory:forgotten", {
          contextId: msg.contextId,
          archived: result?.archived ?? 0,
        });
      }
      // 書き留めたことを発言に見せる（§10.1）。何も書かなければ付けない。
      if (
        decision.note ||
        decision.shelf ||
        decision.terms?.length ||
        decision.people?.length ||
        decision.todos?.length
      ) {
        await reactNoted(msg);
      }
    } catch (err) {
      // Policy Gate や監査で止まることがある（凍結中など）。それは正しい挙動なので、
      // 会話は壊さずに記録だけ残す。
      events.emit("memory:write-failed", { contextId: msg.contextId, error: String(err) });
    }
  }

  /**
   * 記憶に書く前に機微情報を検査し、**印を付ける**（A-1 / ADR 0007）。
   *
   * 落とさないのは、落とすと仕事に使えなくなるから。マーケの相談相手に予算の数字を
   * 覚えさせないなら、そもそも相談相手にならない。**知っているが公開しない**のは
   * 同僚として自然な振る舞いで、公開経路（日記・日報）がこの印を見て出さない。
   *
   * 監査に残すのは**カテゴリだけ**。機微情報を止めた記録に機微情報を書いたら本末転倒（A1-5）。
   */
  async function markSensitive(
    text: string,
    tool: string,
    msg: InboundMessage,
  ): Promise<SensitiveCategory[]> {
    const result = inspectSensitive(text, config.sensitiveGuard);
    if (!result.hit) return [];
    await auditLog.registry.record({
      actor: runtime.agentId,
      action: "memory.sensitive_marked",
      payload: { tool, contextId: msg.contextId, categories: result.categories },
      trustLabel: msg.trustLabel,
    });
    events.emit("memory:sensitive", { contextId: msg.contextId, categories: result.categories });
    return result.categories;
  }

  const catchup = config.catchup ?? {};
  /** 拾い直しを試した回数（contextId ごと）。失敗が続くループを防ぐ。 */
  const catchupAttempts = new Map<string, number>();

  const modelId = config.model ?? [...modelsMap.keys()][0];
  // 記憶の判定に使うモデル。既定は会話用と同じ。安いモデルに寄せたいときに分ける
  // （設計は気づきのスコアラーに Haiku を想定している, §6）。
  const memoryModelId = config.memoryModel ?? modelId;

  /** 凍結中（レベル1/2）の最低限の応答。記憶もモデルも触らず、状況だけ返す。 */
  async function replyFrozen(msg: InboundMessage): Promise<void> {
    const surface = surfaces.get(msg.surfaceId);
    if (!surface) return;
    // 送信は外部 I/O なので、他と同じく**残ってから**送る（fail-closed, §12-7）。
    const audited = await auditLog.registry.record({
      actor: msg.author,
      action: "turn.frozen",
      payload: { surfaceId: msg.surfaceId, contextId: msg.contextId },
      trustLabel: msg.trustLabel,
    });
    if (!audited) return;
    await surface.send({ contextId: msg.contextId, text: FROZEN_NOTICE });
  }

  /** 1 ターン: 記憶読出し→文脈構築→モデル→応答→（記憶書込みはツール経由）。 */
  async function handleInbound(msg: InboundMessage): Promise<void> {
    // 凍結の再検査（§5.1）。silent = 完全沈黙で、監査も外部 I/O も走らせない。
    const freeze = await runtime.freezeLevel();
    if (freeze === "silent") return;
    // P0 は mention のみ応答（自発性なし）
    if (!msg.isMention) return;
    // stopped = 自発行動は凍結、mention には「止まっている」ことだけ返す（§12-4 レベル1/2）。
    if (freeze === "stopped") return await replyFrozen(msg);

    // 受信を監査に残す。本文は入れない（機微情報を監査へ流さない, A1-5）。
    // ここが残せないならターンごと中止する。以降には記憶読出しもモデル呼び出しもあり、
    // 「監査が残らないまま外部 I/O だけ起きる」状態にしない（§12-7）。
    const auditedTurn = await auditLog.registry.record({
      actor: msg.author,
      action: "turn.received",
      payload: {
        surfaceId: msg.surfaceId,
        contextId: msg.contextId,
        textLength: msg.text.length,
      },
      trustLabel: msg.trustLabel,
    });
    if (!auditedTurn) {
      events.emit("turn:error", new Error("audit degraded: ターンを中止しました"));
      return;
    }

    // 記憶読出し（§3.2）
    const mem = services.get<MemoryCapability>(MEMORY_SERVICE);
    const recalled = mem ? await mem.recall(msg.contextId) : { notes: [], books: [] };

    // 単語帳（索引カード）。**この文に出てきた語**を引く（recency ではなく一致）。
    // モデルを使わない照合なので、レイテンシは増えない。
    const terms = mem?.terms ? await mem.terms(msg.text) : [];
    // 個人カルテ。**会話に入れるだけで、公開経路には出さない**（ADR 0008）
    const people = mem?.people ? await mem.people(msg.text) : [];
    // このスレッドで引き受けたまま終わっていない作業（ADR 0009）。
    // 全部ではなくスレッド分だけ入れる——「さっきの件どうなった」に答えられれば足りる。
    const todos = mem?.openTodos ? await mem.openTodos(msg.contextId) : [];

    // 文脈構築
    const memoryBlock = [
      recalled.notes.length ? `メモ:\n- ${recalled.notes.join("\n- ")}` : "",
      recalled.books.length
        ? `本棚:\n- ${recalled.books.map((b) => `${b.title}: ${b.card}`).join("\n- ")}`
        : "",
      // このチームでだけ通じる言葉。**知らない前提で説明し直さない**ために先に渡す
      terms.length
        ? `この会話に出てくる言葉:\n- ${terms.map((t) => `${t.name}: ${t.definition}`).join("\n- ")}`
        : "",
      people.length
        ? `この会話に出てくる人:\n- ${people.map((p) => `${p.name}: ${p.note}`).join("\n- ")}`
        : "",
      todos.length
        ? `このスレッドで抱えている作業:\n- ${todos
            .map(
              (t) =>
                `${t.content}${t.waitingFor ? `（${t.waitingFor} の返事待ち）` : ""}` +
                `${t.staleDays >= 1 ? ` — ${t.staleDays}日動いていない` : ""}`,
            )
            .join("\n- ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const system = `${personaPrompt()}\n${memoryBlock}`;

    // モデル呼び出し（provider はプラグイン）。
    // これは外部 I/O（会話がプロセス外へ出て課金される）なので、他の副作用と同じく
    // **呼ぶ前**に監査へ残し、残せなければ呼ばない。
    const provider = modelId ? models.get(modelId) : undefined;
    if (provider) {
      const auditedCall = await auditLog.registry.record({
        actor: runtime.agentId,
        action: "model.requested",
        payload: {
          model: modelId ?? null,
          contextId: msg.contextId,
          recalledNotes: recalled.notes.length,
          recalledBooks: recalled.books.length,
        },
        trustLabel: msg.trustLabel,
      });
      if (!auditedCall) {
        events.emit("turn:error", new Error("audit degraded: モデル呼び出しを抑止しました"));
        return;
      }
    }
    const history = provider ? await conversationFor(msg) : [];
    /**
     * このターンで読んだもの。返答の材料であり、**記憶の材料でもある**。
     * ここに溜めておかないと「これ読んでおいて」で読んだ内容が記憶に残らない。
     */
    const gathered: string[] = [];
    let replyText = provider
      ? (await provider.complete({ system, user: msg.text, history })).text
      : "（モデル未登録のため応答できません）";

    // 調べもの: 返答が JSON なら道具を使い、結果を足してもう一度答えさせる。
    //
    // **1回では足りない。** 検索して id を得てから中身を読む、という当たり前の流れが
    // 2手かかるため。最初 1回に制限したら、検索が成功しているのに「うまく調べられません
    // でした」と返す状態になった（実際 Slack で連発した）。
    //
    // 代わりに**歩数・時間・重複**の3つで頭を打つ。無限に往復しないことと、
    // 会話のレイテンシを守ることが目的で、1回に絞ることが目的ではない。
    if (provider) {
      const catalog = lookupCatalog(equipment.getAll(), toolsMap, TOOL_DESCRIPTIONS);
      if (catalog.length > 0) {
        const deadline = Date.now() + LOOKUP_DEADLINE_MS;
        /** 同じ道具・同じ入力を繰り返させない（同じ結果で往復し続けるため）。 */
        const tried = new Set<string>();
        let steps = 0;
        let stop: string | undefined;

        const answerWith = async (extra: string): Promise<string> =>
          (
            await provider.complete({
              system,
              user: [msg.text, ...gathered, extra].filter(Boolean).join("\n\n---\n"),
              history,
            })
          ).text;

        while (true) {
          const request = parseLookup(replyText);
          if (!request) break; // 文章で答えた＝完了

          const allowed = allowedLookup(request, catalog);
          if (!allowed) {
            // 名乗った道具を持っていない。モデルの言う名前を信用しない（§12-3）
            events.emit("lookup:rejected", { contextId: msg.contextId, tool: request.tool });
            stop = `「${request.tool}」は持っていません。`;
            break;
          }
          const key = `${allowed.tool}:${JSON.stringify(allowed.input)}`;
          if (steps >= MAX_LOOKUPS_PER_TURN || Date.now() > deadline || tried.has(key)) {
            stop = "";
            break;
          }
          tried.add(key);
          steps++;

          let result: unknown;
          try {
            // 引き金は相手の発言なので untrusted のまま Policy Gate を通す
            result = await invokeTool(allowed.tool, allowed.input, msg.trustLabel);
          } catch (err) {
            result = { status: "failed", detail: String(err) };
          }
          events.emit("lookup:done", { contextId: msg.contextId, tool: allowed.tool, step: steps });
          gathered.push(renderLookupResult(allowed.tool, result));
          replyText = await answerWith("");
        }

        // 打ち切るときも**定型文で返さない**。分かった範囲で答えさせ、
        // 足りない部分は本人に言わせる（それが正直で、相手にも役に立つ）。
        if (stop !== undefined) {
          replyText = await answerWith(`${stop}\n${NO_MORE_LOOKUP}`);
        }
        // それでも JSON なら、さすがに Slack へ流さない
        if (parseLookup(replyText)) {
          replyText = "すみません、調べきれませんでした。何を見に行けばよいか教えてもらえますか。";
        }
      }
    }
    // 今回の往復を文脈に足す。次のターンで「さっきの話」が通じるようにする。
    appendTurn(msg.contextId, { role: "user", text: msg.text });
    appendTurn(msg.contextId, { role: "assistant", text: replyText });
    await auditLog.registry.record({
      actor: runtime.agentId,
      action: "model.completed",
      payload: { model: modelId ?? null, contextId: msg.contextId, replyLength: replyText.length },
      trustLabel: msg.trustLabel, // untrusted 入力を食わせた生成物は untrusted のまま
    });

    // 応答（受信元 surface へ返す）
    const surface = surfaces.get(msg.surfaceId);
    const text = replyText;
    if (!surface) return;
    // 副作用の直前にキルスイッチを再検査する（§5.1）。ターンの途中で `/russell stop` が
    // 入ったらここで止まる——モデル呼び出しの間に発動されるのが実際に多いケース。
    if ((await runtime.freezeLevel()) !== "none") {
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "surface.send.suppressed",
        payload: { surfaceId: msg.surfaceId, contextId: msg.contextId, reason: "killswitch" },
        trustLabel: "trusted",
      });
      events.emit("turn:frozen", { contextId: msg.contextId });
      return;
    }
    // 実行モード（§6.5）。**dryrun では送らない。** 返信も外部への送信なので、
    // ここを通すと「本番ワークスペースに繋いだが dryrun だから安全」が嘘になる。
    if (!modeAllowsSend(runtime.mode())) {
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "surface.send.suppressed",
        payload: {
          surfaceId: msg.surfaceId,
          contextId: msg.contextId,
          reason: modeSuppressionReason(runtime.mode()),
          textLength: text.length, // 本文は残さない（A1-5）
        },
        trustLabel: "trusted",
      });
      // **送るはずだった内容は見せる。** 見えないと dryrun で何も確かめられない。
      // 監査ではなく event / ログに出す（本文を監査へ流さない, A1-5）。
      events.emit("surface:send-suppressed", { contextId: msg.contextId, text });
      console.log(`[${runtime.mode()}] 送信せず（${msg.contextId}）: ${text}`);
      await decideMemory(msg, replyText, gathered);
      return;
    }
    // 送信は external_send 相当。監査が残せないなら送らない（fail-closed, §12-7）。
    if (!auditLog.registry.healthy()) {
      events.emit("turn:error", new Error("audit degraded: 応答送信を抑止しました"));
      return;
    }
    // この記録自体が sink 全滅の初回になることがあるので、戻り値でもう一度確かめてから送る。
    const audited = await auditLog.registry.record({
      actor: runtime.agentId,
      action: "surface.send",
      payload: { surfaceId: msg.surfaceId, contextId: msg.contextId, textLength: text.length },
      trustLabel: "trusted", // 送信は個体自身の行為
    });
    if (!audited) {
      events.emit("turn:error", new Error("audit degraded: 応答送信を抑止しました"));
      return;
    }
    const delivery = await surface.send({ contextId: msg.contextId, text });
    // 返答を送ってから、何を書き留めるかを決める（レイテンシを返答の前に積まない）。
    await decideMemory(msg, replyText, gathered);
    if (delivery.status !== "succeeded") {
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "surface.send.result",
        payload: { surfaceId: msg.surfaceId, status: delivery.status, detail: delivery.detail },
        trustLabel: "trusted",
      });
    }
  }

  /**
   * ターンが落ちたことを相手に伝える。**黙って落ちない**（#25）。
   *
   * 落ちた理由は言わない（内部エラーは相手に意味が無く、内部構造を晒す面もある）。
   * ただし「聞こえていたが答えられなかった」ことは伝える——同僚が無言で立ち去るのが
   * いちばん困る。実際、隔離チェックで中止されたターンが Slack 上では
   * 「既読無視」に見えていた。
   *
   * ここ自体が失敗しても握り潰す。**失敗の通知の失敗**でターンを二重に壊さない。
   */
  async function notifyTurnFailed(msg: InboundMessage): Promise<void> {
    try {
      if ((await runtime.freezeLevel()) !== "none") return; // 凍結中は沈黙が正しい
      if (!auditLog.registry.healthy()) return; // 監査が残せないなら送らない（§12-7）
      const surface = surfaces.get(msg.surfaceId);
      if (!surface) return;
      const audited = await auditLog.registry.record({
        actor: runtime.agentId,
        action: "surface.send",
        payload: { surfaceId: msg.surfaceId, contextId: msg.contextId, reason: "turn_failed" },
        trustLabel: "trusted",
      });
      if (!audited) return;
      await surface.send({
        contextId: msg.contextId,
        text: "すみません、いまうまく応答できませんでした。もう一度お願いできますか。",
      });
    } catch {
      // 通知に失敗しても turn.failed は既に残っている。ここで投げると catch の外へ出る。
    }
  }

  // 起動を監査に残す（どの config_version・どのモードで動き出したか、§6.1/§6.5）。
  await auditLog.registry.record({
    actor: runtime.agentId,
    action: "agent.started",
    payload: {
      mode: runtime.mode(),
      plugins: plugins.map((p) => p.id),
      model: modelId ?? null,
    },
    trustLabel: "trusted",
  });

  /**
   * 積み残しの確認。**返信し忘れているやりとりを探して、通常のターンとして流す。**
   *
   * Bob が黙る原因は1つではない（プロセスが落ちていた・再起動中だった・Slack の
   * イベントが届かなかった・ターンが例外で落ちた）。個別に潰しても次の原因が現れるので、
   * **結果の側から回復する**。
   *
   * べき等性は通信面の判定に委ねている——「最後の発言が自分か」で決まるので、
   * 返信した時点で対象から外れる。コア側に「返信済み」の台帳を持たない。
   */
  async function sweepPending(): Promise<void> {
    if (catchup.enabled === false) return;
    // 対応する通信面が無ければ何もしない。**凍結の検査より先に見る**——
    // 拾い直しようが無いのにキルスイッチを読みに行く必要はない（DB を1回叩く）。
    const capable = surfaces.getAll().filter((s) => s.pendingMessages);
    if (capable.length === 0) return;
    // 凍結中は自発的に動かない（§12-4）。解除後の確認で拾えばよい
    if ((await runtime.freezeLevel()) !== "none") return;
    const since = new Date(Date.now() - (catchup.windowMs ?? DEFAULT_CATCHUP_WINDOW_MS));
    const limit = catchup.limit ?? DEFAULT_CATCHUP_LIMIT;

    for (const surface of capable) {
      if (!surface.pendingMessages) continue;
      let pending: InboundMessage[];
      try {
        pending = await surface.pendingMessages({ since, limit });
      } catch (err) {
        events.emit("catchup:error", err);
        continue;
      }
      if (pending.length === 0) continue;
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "catchup.found",
        payload: { surfaceId: surface.id, count: pending.length },
        trustLabel: "trusted",
      });
      for (const msg of pending) {
        // 同じやりとりを何度も試し続けない。**失敗が続くとループになる**ので上限を持つ。
        // プロセス内にしか持たないのは、再起動が実質のリセットとして働くため。
        const attempts = catchupAttempts.get(msg.contextId) ?? 0;
        if (attempts >= MAX_CATCHUP_ATTEMPTS) continue;
        catchupAttempts.set(msg.contextId, attempts + 1);
        enqueueTurn(msg);
      }
    }
  }

  // surfaces を購読して認知ループを起動。
  // 同一 context（スレッド）のターンは直列化する（記憶の読み書き順を保つ）。
  const turnQueues = new Map<string, Promise<void>>();
  function enqueueTurn(msg: InboundMessage): void {
    const prev = turnQueues.get(msg.contextId) ?? Promise.resolve();
    const next = prev
      .then(() => handleInbound(msg))
      .catch(async (err) => {
        await auditLog.registry.record({
          actor: runtime.agentId,
          action: "turn.failed",
          payload: { contextId: msg.contextId, error: String(err) },
          trustLabel: msg.trustLabel,
        });
        events.emit("turn:error", err);
        await notifyTurnFailed(msg);
      });
    turnQueues.set(msg.contextId, next);
  }
  for (const surface of surfaces.getAll()) {
    await surface.start(enqueueTurn);
  }

  // 起動直後に1回。**再起動中に来たメッセージを拾うのが本来の目的**なので、
  // 間隔を待たずにまず確認する。
  await sweepPending();
  const catchupTimer =
    (catchup.intervalMs ?? DEFAULT_CATCHUP_INTERVAL_MS) > 0
      ? setInterval(() => {
          void sweepPending();
        }, catchup.intervalMs ?? DEFAULT_CATCHUP_INTERVAL_MS)
      : undefined;
  catchupTimer?.unref();

  return {
    ctx,
    async invokeTool(name: string, input: unknown, trustLabel: TrustLabel = "untrusted") {
      return await invokeTool(name, input, trustLabel);
    },
    async destroy() {
      if (catchupTimer) clearInterval(catchupTimer);
      // 実行中のターンを待ってから片付ける。待たずに teardown するとプールも surface も
      // 閉じてしまい、**終了直前のターンだけが黙って消える**（`echo ... | pnpm dev` のように
      // 入力の直後に EOF が来る経路で顕著）。ハングしたターンで終われなくならないよう上限付き。
      await Promise.race([
        Promise.allSettled([...turnQueues.values()]),
        new Promise<void>((resolve) => {
          setTimeout(resolve, DRAIN_TIMEOUT_MS).unref();
        }),
      ]);
      // 停止も監査に残す。sink（プラグイン）の teardown より前に記録する。
      await auditLog.registry.record({
        actor: runtime.agentId,
        action: "agent.stopped",
        payload: {},
        trustLabel: "trusted",
      });
      for (const t of [...teardowns].reverse()) await t();
      auditLog.clear();
    },
  };
}
