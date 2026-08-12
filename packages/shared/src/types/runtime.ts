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
/**
 * 個人カルテの1件（索引カード, `entities` の type='person'）。
 *
 * **書いてよいのは事実だけ**（呼び名・所属・担当・詳しい領域・連絡の好み）。
 * 評価・人物評は書かない（privacy-and-memory-policy §1 / ADR 0008）。
 */
export interface RecalledPerson {
  name: string;
  note: string;
}

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
  /**
   * 受信テキストに出てくる**人**を引く（個人カルテ, ADR 0008）。
   *
   * `terms` と分けてあるのは、文脈へ入れるときの見出しが違うのと、
   * **人の情報は公開経路に出さない**という扱いの差を型の上でも見せておくため。
   */
  people?(text: string): Promise<RecalledPerson[]> | RecalledPerson[];
  /**
   * 登録済みの見出し語と別名を返す（本文は返さない）。
   *
   * **記憶を決めるモデルに「もう知っている語」を見せるため**にある。これが無いと毎ターン
   * 白紙から書くので、既に別名として登録されている語をまた新しい行として作る
   * （実際、同じプロジェクトが4行に分かれた）。
   */
  glossary?(): Promise<GlossaryEntry[]> | GlossaryEntry[];
  /**
   * 引き受けたまま終わっていない作業（ADR 0009）。
   *
   * `contextId` を渡すとそのスレッドの分だけ。省略すると全部（日報と判定に使う）。
   */
  openTodos?(contextId?: string): Promise<OpenTodo[]> | OpenTodo[];
}

/** 未完了の作業1件。 */
export interface OpenTodo {
  id: number;
  content: string;
  state: "open" | "waiting";
  waitingFor?: string;
  /** 最後に動いた日からの経過日数。**止まっていることを見えるようにする**ための値。 */
  staleDays: number;
}

/** 単語帳の見出しだけ（重複を避けるためにモデルへ見せる）。 */
export interface GlossaryEntry {
  name: string;
  aliases: string[];
}

/** services のキー定数。 */
export const MEMORY_SERVICE = "memory";

/**
 * 運用設定（日報の投稿先など）。**env ではなく DB に置く**——変更履歴が要るため（§6.1）。
 */
export interface SettingsCapability {
  /** `agentId` 省略時は自分の設定。`"*"` は全個体の既定（キルスイッチの target と同じ形）。 */
  get(key: string, agentId?: string): Promise<string | undefined>;
  /** 変更は監査に残る。`updatedBy` は変更した人（Slack user id 等）。 */
  set(
    key: string,
    value: string | null,
    updatedBy: string,
    agentId?: string,
  ): Promise<{ before?: string }>;
}

export const SETTINGS_SERVICE = "settings";
