/**
 * 認知ループが使うランタイム型（提案骨格）。
 * モデル呼び出しと記憶 capability の最小インターフェース。
 */

/** 会話の1発言。 */
export interface ModelTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ModelRequest {
  system: string;
  user: string;
  /**
   * 同じ文脈での直近のやりとり（古い順、今回の発言は含まない）。
   *
   * **長期記憶（メモ帳・本棚）とは別物。** あちらは「後から思い出すために書き留めたもの」で、
   * こちらは「いま話している最中に覚えている直前の数往復」。人間で言えば前者が手帳、
   * 後者が短期記憶にあたる。両方ないと会話にならない——記憶があっても直前の発言を
   * 忘れていたら話が通じないし、直前しか覚えていなければ昨日の話ができない。
   *
   * 対応しないプロバイダは無視してよい（任意項目）。
   */
  history?: ModelTurn[];
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
/** 単語帳の1件（索引カード, `entities` の type='term'）。 */
export interface RecalledTerm {
  name: string;
  definition: string;
}

export interface MemoryCapability {
  recall(contextId: string): Promise<RecalledContext> | RecalledContext;
  /**
   * 受信テキストに出てくる**既知の用語**を引く（単語帳）。対応しない実装は持たなくてよい。
   *
   * 引き方が `recall` と違うので分けてある: recall は「このスレッドの直近」を返すが、
   * こちらは「**この文に出てきた語**」を返す。recency ではなく一致で引く。
   * 別名は文字列なので**モデルを使わずに照合できる**（レイテンシを増やさない）。
   */
  terms?(text: string): Promise<RecalledTerm[]> | RecalledTerm[];
}

/** services のキー定数。 */
export const MEMORY_SERVICE = "memory";
