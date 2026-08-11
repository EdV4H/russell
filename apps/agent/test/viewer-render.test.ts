/**
 * ビューアの表示（env 不要）。
 *
 * 記憶の中身は他者が書いた untrusted テキストなので、**エスケープが本体**（§12-3）。
 * 本棚に `<script>` を仕込まれて、それを見に行った人の画面で動く、が最悪の筋。
 */

import {
  BOXES,
  escapeHtml,
  formatCell,
  renderAgentPicker,
  renderPage,
  renderTable,
  truncate,
} from "@edv4h/russell-viewer";
import { expect, test } from "vitest";

test("本文に仕込まれた HTML は実行されない", () => {
  const nasty = '<script>alert(1)</script><img src=x onerror="steal()">';
  const html = renderTable(["card"], [{ card: nasty }]);

  // 危ないのは「onerror= という文字列が残ること」ではなく、タグと属性が**成立すること**。
  // < が潰れていればタグにならず、" が潰れていれば属性から抜け出せない。
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img src=x onerror=&quot;steal()&quot;&gt;");
  // 中身は（エスケープされた形で）ちゃんと読める
  expect(html).toContain("alert(1)");
});

test("属性を抜けるための引用符も潰す", () => {
  expect(escapeHtml(`" onmouseover="x`)).toBe("&quot; onmouseover=&quot;x");
  expect(escapeHtml("' onfocus='x")).toBe("&#39; onfocus=&#39;x");
});

test("長い本文は切り詰める（一覧が壊れない）", () => {
  const long = "あ".repeat(500);
  expect(truncate(long).length).toBe(401); // 400 + 省略記号
  expect(truncate("短い")).toBe("短い");
});

test("空・日時・JSON をそれぞれ読める形にする", () => {
  expect(formatCell(null)).toContain("—");
  expect(formatCell(new Date("2026-08-10T09:15:00Z"))).toBe("2026-08-10 09:15:00");
  expect(formatCell({ tool: "shelf.add" })).toContain("shelf.add");
});

test("中身が無いときは空表ではなくそう伝える", () => {
  expect(renderTable(["a"], [])).toContain("まだ何も入っていません");
});

test("ページには全部の箱への導線があり、いまいる箱が分かる", () => {
  const page = renderPage("/books", "本棚", "説明", "<p>中身</p>");
  for (const box of ["メモ帳", "本棚", "書庫", "日記", "監査ログ", "キルスイッチ"]) {
    expect(page).toContain(box);
  }
  expect(page).toContain('<a href="/books" class=on>');
  expect(page).toContain("読み取り専用");
});

test("個体を選べる。選んだ個体は箱を移っても保たれる", () => {
  const page = renderPage("/books", "本棚", "説明", "<p>中身</p>", {
    agent: "bob",
    agents: ["alice", "bob"],
  });

  // 個体の切り替え（全個体＋各個体）
  expect(page).toContain('<a href="/books?agent=alice">alice</a>');
  expect(page).toContain('<a href="/books?agent=bob" class=on>bob</a>');
  expect(page).toContain('<a href="/books">全個体</a>');
  // 箱を移っても bob のまま
  expect(page).toContain('<a href="/notes?agent=bob"');
  expect(page).toContain('<a href="/?agent=bob"');
});

test("個体が選ばれていなければ、箱のリンクに絞り込みは付かない", () => {
  const page = renderPage("/books", "本棚", "説明", "", { agents: ["bob"] });

  // 箱への導線は素の URL（全個体を見ている）
  expect(page).toContain('<a href="/notes"');
  expect(page).toContain('<a href="/"');
  // 「全個体」が選択状態。切り替え先としての ?agent=bob は当然ある
  expect(page).toContain('<a href="/books" class=on>全個体</a>');
  expect(page).toContain('<a href="/books?agent=bob">bob</a>');
});

test("個体名は URL に載るのでエスケープする", () => {
  // 個体 ID は本来 [a-z0-9_-] だが、表示側は入力を信じない
  const page = renderPage("/books", "本棚", "", "", {
    agent: '"><script>x</script>',
    agents: ['"><script>x</script>'],
  });
  expect(page).not.toContain("<script>x</script>");
  expect(page).toContain("%3E%3Cscript%3E"); // href は URL エンコード
});

test("個体がいなければ切り替えは出さない", () => {
  expect(renderAgentPicker([], undefined, "/books")).toBe("");
});

test("単語帳の箱がある（本棚とは別の箱として見える）", () => {
  const terms = BOXES.find((b) => b.path === "/terms");

  expect(terms?.title).toBe("単語帳");
  // 本棚との違い（忘却しない・別名で引く）が説明に出ている
  expect(terms?.description).toContain("忘却しない");
  expect(terms?.description).toContain("別名");
});

test("箱の並びは記憶の流れに沿っている（メモ帳 → 本棚 → 単語帳 → 書庫）", () => {
  const paths = BOXES.map((b) => b.path);

  expect(paths.indexOf("/notes")).toBeLessThan(paths.indexOf("/books"));
  expect(paths.indexOf("/books")).toBeLessThan(paths.indexOf("/terms"));
  expect(paths.indexOf("/terms")).toBeLessThan(paths.indexOf("/archive"));
});
