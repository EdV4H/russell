/**
 * 認知ループが使うランタイム型（提案骨格）。
 * モデル呼び出しと記憶 capability の最小インターフェース。
 */

export interface ModelRequest {
  system: string;
  user: string;
}

export interface ModelResponse {
  text: string;
}

export interface RecalledBook {
  title: string;
  card: string;
}

/** 会話時の記憶読み出し結果（§3.2）。当該スレッドのメモ＋関連する本。 */
export interface RecalledContext {
  notes: string[];
  books: RecalledBook[];
}

/**
 * 記憶 capability。memory プラグインが `ctx.services.provide("memory", …)` で提供し、
 * コアの認知ループが `ctx.services.get("memory")` で使う（記憶実装＝プラグイン、§plugin-first）。
 * 書き込みは `note.write` / `shelf.add` ツール経由（Policy Gate を通す）。
 */
export interface MemoryCapability {
  recall(contextId: string): Promise<RecalledContext> | RecalledContext;
}

/** services のキー定数。 */
export const MEMORY_SERVICE = "memory";
