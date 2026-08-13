/**
 * ビューアの門番（#81）。env 不要。
 *
 * ビューアは**記憶の本文がそのまま出る**。これまでは `127.0.0.1` にしか待ち受けないことだけで
 * 守っていたので、**うっかり外向きにしたら全部出る**。
 *
 * ここで固めたいのは「合言葉が合うか」より、**外向きなのに合言葉が無いときに起動しない**こと。
 * 警告では防げない——動いてしまうので。
 */

import { authorize, checkStartup, isLoopback } from "@edv4h/russell-viewer/access";
import { expect, test } from "vitest";

const TOKEN = "0123456789abcdef0123"; // 20文字（下限は16）
const url = (q = "") => new URL(`http://x/notes${q}`);

test("ループバックの見分け", () => {
  expect(isLoopback("127.0.0.1")).toBe(true);
  expect(isLoopback("localhost")).toBe(true);
  expect(isLoopback("::1")).toBe(true);
  expect(isLoopback("[::1]")).toBe(true);
  expect(isLoopback("127.0.0.53")).toBe(true);
  expect(isLoopback("0.0.0.0")).toBe(false); // **これがいちばんありそうな事故**
  expect(isLoopback("10.0.0.5")).toBe(false);
});

test("手元で見るだけなら、今までどおり合言葉は要らない", () => {
  expect(checkStartup({ host: "127.0.0.1" })).toEqual({ ok: true });
  expect(authorize({ host: "127.0.0.1" }, { url: url() }).allowed).toBe(true);
});

test("**外向きなのに合言葉が無ければ起動しない**（警告では防げない）", () => {
  const result = checkStartup({ host: "0.0.0.0" });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // 何をすればよいかまで書く
  expect(result.reason).toContain("RUSSELL_VIEWER_TOKEN");
  expect(result.reason).toContain("記憶の本文");
});

test("短い合言葉は受け付けない（指定されているから安全、にしない）", () => {
  expect(checkStartup({ host: "0.0.0.0", token: "short" }).ok).toBe(false);
  expect(checkStartup({ host: "0.0.0.0", token: TOKEN }).ok).toBe(true);
});

test("合言葉が合えば通し、Cookie へ移す（URL に残し続けない）", () => {
  const gate = authorize({ host: "0.0.0.0", token: TOKEN }, { url: url(`?token=${TOKEN}`) });

  expect(gate.allowed).toBe(true);
  if (!gate.allowed) return;
  expect(gate.setCookie).toContain("russell_viewer=");
  // 画面のスクリプトから読めない・他所のページからは送られない
  expect(gate.setCookie).toContain("HttpOnly");
  expect(gate.setCookie).toContain("SameSite=Lax");
});

test("2回目以降は Cookie で通る", () => {
  const gate = authorize(
    { host: "0.0.0.0", token: TOKEN },
    { url: url(), cookie: `other=1; russell_viewer=${TOKEN}` },
  );

  expect(gate.allowed).toBe(true);
});

test("合言葉が違えば通さない", () => {
  const bad = authorize({ host: "0.0.0.0", token: TOKEN }, { url: url("?token=nope") });
  expect(bad).toEqual({ allowed: false, reason: "bad_token" });

  const none = authorize({ host: "0.0.0.0", token: TOKEN }, { url: url() });
  expect(none).toEqual({ allowed: false, reason: "no_token" });

  const staleCookie = authorize(
    { host: "0.0.0.0", token: TOKEN },
    { url: url(), cookie: "russell_viewer=old" },
  );
  expect(staleCookie).toEqual({ allowed: false, reason: "bad_token" });
});
