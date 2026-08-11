/**
 * Notion の API レスポンスを、モデルに渡せる素のテキストへ変換する。
 *
 * ここは**純関数だけ**。HTTP を知らないので、実際のレスポンス JSON を貼り付けてテストできる。
 * Notion のブロック構造は再帰的で種類も多いが、装備の役割は「読めるようにする」ことなので、
 * 見出し・段落・リスト・コードなど**本文として意味のあるもの**だけを拾い、装飾は落とす。
 */

/** 取り出したページの見出し情報。検索結果の一覧に使う。 */
export interface NotionPageRef {
  id: string;
  title: string;
  url: string;
  lastEditedAt?: string;
}

interface RichText {
  plain_text?: string;
}

/** `rich_text` 配列を1つの文字列にする。装飾（太字・色）は落とす。 */
export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r) => (typeof (r as RichText)?.plain_text === "string" ? (r as RichText).plain_text : ""))
    .join("")
    .trim();
}

/**
 * ページ/データベースのタイトルを取り出す。
 *
 * Notion はページ種別ごとにタイトルの置き場所が違う（データベース直下のページは
 * プロパティのどれかが `type: "title"`、データベース自体は `title` 配列）。
 * どこにも無ければ**空文字ではなく「無題」**を返す——一覧に空行が並ぶと選べないので。
 */
export function pageTitle(page: unknown): string {
  if (typeof page !== "object" || page === null) return "無題";
  const p = page as Record<string, unknown>;

  // データベース、または title 配列を直接持つもの
  const direct = plainText(p.title);
  if (direct) return direct;

  const props = p.properties;
  if (typeof props === "object" && props !== null) {
    for (const value of Object.values(props as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as Record<string, unknown>;
      if (v.type === "title") {
        const text = plainText(v.title);
        if (text) return text;
      }
    }
  }
  return "無題";
}

/** 検索結果1件をページ参照に落とす。 */
export function toPageRef(item: unknown): NotionPageRef | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const p = item as Record<string, unknown>;
  if (typeof p.id !== "string") return undefined;
  return {
    id: p.id,
    title: pageTitle(p),
    url: typeof p.url === "string" ? p.url : "",
    lastEditedAt: typeof p.last_edited_time === "string" ? p.last_edited_time : undefined,
  };
}

/** ブロック種別ごとの前置き。Markdown に寄せると、そのまま読ませたときに構造が伝わる。 */
const PREFIX: Record<string, string> = {
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "- ",
  numbered_list_item: "- ",
  to_do: "- ",
  quote: "> ",
  code: "",
  paragraph: "",
  toggle: "",
  callout: "",
};

/**
 * ブロック1件を1行のテキストにする。**本文を持たない種別は空文字**（呼び出し側が捨てる）。
 *
 * 画像・埋め込み・区切り線などは、テキストとしては情報がないので落とす。
 * 「読めなかった」ではなく「読むものが無かった」なので、欠落として扱わない。
 */
export function blockToText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const b = block as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : "";
  const prefix = PREFIX[type];
  if (prefix === undefined) return "";

  const body = b[type];
  if (typeof body !== "object" || body === null) return "";
  const text = plainText((body as Record<string, unknown>).rich_text);
  if (!text) return "";

  // チェックボックスは状態が意味を持つ（未完のタスクかどうか）
  if (type === "to_do") {
    const checked = (body as Record<string, unknown>).checked === true;
    return `- [${checked ? "x" : " "}] ${text}`;
  }
  return `${prefix}${text}`;
}

/** ブロックの配列を本文テキストにする。空行は畳む。 */
export function blocksToText(blocks: unknown[]): string {
  return blocks
    .map(blockToText)
    .filter((line) => line !== "")
    .join("\n");
}
