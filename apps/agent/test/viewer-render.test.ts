/**
 * ビューアの表示（env 不要）。
 *
 * 記憶の中身は他者が書いた untrusted テキストなので、**エスケープが本体**（§12-3）。
 * 本棚に `<script>` を仕込まれて、それを見に行った人の画面で動く、が最悪の筋。
 */

import { escapeHtml, formatCell, renderPage, renderTable, truncate } from "@edv4h/russell-viewer";
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
