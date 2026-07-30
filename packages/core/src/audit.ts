/**
 * 監査ログ（event_log）のコア実装。設計書 §3.1 / §12-7。
 *
 * コアは「記録する義務」だけを持ち、永続化先は知らない（plugin-first）。
 * - sink 未登録: インメモリのリングバッファのみ。オフライン stack / テスト用。永続化されていないので
 *   **healthy=false** 扱いにはしない（sink を要求するかは組み立て側=プリセットの責任）。
 * - sink 登録済みで write が失敗: **degraded**。以降 Policy Gate が副作用を止める（fail-closed）。
 *   復旧は次の成功した write で自動（監査が再び残せるようになったら再開してよい）。
 *
 * 記録は「行為の前」に行う。監査が残らないまま副作用だけ起きる窓を作らないため。
 */

import type {
  AgentRuntime,
  AuditEvent,
  AuditRecordInput,
  AuditRegistry,
  AuditSink,
  EventBus,
} from "@edv4h/russell-shared";

/** インメモリに保持する直近イベント数。調査用であって永続化の代替ではない。 */
const RING_SIZE = 500;

export interface AuditLog {
  registry: AuditRegistry;
  /** teardown 用。登録済み sink をすべて外す。 */
  clear(): void;
}

export function createAuditLog(runtime: AgentRuntime, events: EventBus): AuditLog {
  const sinks: AuditSink[] = [];
  const ring: AuditEvent[] = [];
  let degraded = false;

  function remember(event: AuditEvent): void {
    ring.push(event);
    if (ring.length > RING_SIZE) ring.shift();
  }

  const registry: AuditRegistry = {
    registerSink(sink: AuditSink) {
      sinks.push(sink);
      return () => {
        const i = sinks.indexOf(sink);
        if (i >= 0) sinks.splice(i, 1);
      };
    },

    async record(input: AuditRecordInput) {
      const event: AuditEvent = {
        ts: new Date().toISOString(),
        actor: input.actor,
        action: input.action,
        payload: input.payload ?? {},
        trustLabel: input.trustLabel,
        agentId: runtime.agentId,
        configVersion: runtime.configVersion,
      };
      remember(event);

      if (sinks.length === 0) return; // 永続化先が無い構成（オフライン/テスト）

      const results = await Promise.allSettled(sinks.map((s) => s.write(event)));
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length === results.length) {
        // 全滅 = 監査が残せない。fail-closed へ倒す（§12-7）。
        if (!degraded) {
          degraded = true;
          events.emit("audit:degraded", { action: event.action });
        }
        // 最後の砦として stderr に出す（プロセスログは残る）
        console.error("[audit] 全 sink への追記に失敗。fail-closed。", JSON.stringify(event));
        return;
      }
      if (failed.length > 0) {
        // 一部だけ失敗: 監査は残っているので degraded にはしないが、可視化する。
        events.emit("audit:sink-error", { action: event.action, failed: failed.length });
      }
      if (degraded) {
        degraded = false;
        events.emit("audit:recovered", { action: event.action });
      }
    },

    recent(limit = RING_SIZE) {
      return ring.slice(-limit);
    },

    healthy() {
      return !degraded;
    },
  };

  return {
    registry,
    clear() {
      sinks.length = 0;
    },
  };
}
