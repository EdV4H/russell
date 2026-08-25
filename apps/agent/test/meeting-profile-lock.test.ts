/**
 * Chrome のプロファイルに残るロックの後片付け（#130）。ファイルも Chrome も触らない。
 *
 * 実際に3回続けて会議に入れず、毎回の答えが「アクティビティモニタで Chrome を探して
 * 終了してください」だった。**このプロファイルは個体専用**で他に開く者はいないのだから、
 * 死んでいるロックは自分で片付けられる。
 *
 * ここで固めたいのは「消せること」より、**生きているものを消さないこと**。
 * 共用のプロファイルで同じことをすれば、動いている Chrome のデータを壊す。
 */

import {
  clearStaleProfileLock,
  parseLockOwner,
  sameHost,
} from "@edv4h/russell-plugin-meeting-browser";
import { expect, test } from "vitest";

const HOST = "ATR-LAP-OSX-YUSUKE";

/** 消した名前を記録するだけの偽物。 */
function fakeFs(target: string | undefined) {
  const removed: string[] = [];
  return {
    removed,
    deps: {
      host: HOST,
      readLink: () => {
        if (target === undefined) throw new Error("ENOENT");
        return target;
      },
      unlink: (path: string) => {
        removed.push(path.split("/").pop() ?? path);
      },
    },
  };
}

test("ロックの持ち主を読む（末尾が pid、その前がホスト名）", () => {
  expect(parseLockOwner("ATR-LAP-OSX-YUSUKE-MARUYAMA-60615")).toEqual({
    host: "ATR-LAP-OSX-YUSUKE-MARUYAMA",
    pid: 60615,
  });
  // 読めないものは当てにいかない
  expect(parseLockOwner("こわれている")).toBeUndefined();
  expect(parseLockOwner("host-0")).toBeUndefined();
});

test("同じ機械かどうかを、表記ゆれで取り違えない", () => {
  expect(sameHost("mac.local", "MAC")).toBe(true);
  expect(sameHost("mac", "other")).toBe(false);
});

test("**持ち主が死んでいれば片付ける**", () => {
  const fs = fakeFs(`${HOST}-999`);
  const verdict = clearStaleProfileLock("/p", { ...fs.deps, isAlive: () => false });

  expect(verdict).toEqual({ action: "cleared", pid: 999 });
  // 消すのは Singleton 系だけ。**プロファイルの中身には触らない**
  expect(fs.removed.sort()).toEqual(["SingletonCookie", "SingletonLock", "SingletonSocket"]);
});

test("**生きているなら消さない。誰が持っているかを言う**", () => {
  const fs = fakeFs(`${HOST}-777`);
  const verdict = clearStaleProfileLock("/p", { ...fs.deps, isAlive: () => true });

  // 消したら、動いている Chrome のデータを壊す
  expect(verdict).toEqual({ action: "held", pid: 777 });
  expect(fs.removed).toEqual([]);
});

test("**別の機械が持っていたら触らない**（生死を確かめようがない）", () => {
  const fs = fakeFs("OTHER-MACHINE-123");
  const verdict = clearStaleProfileLock("/p", { ...fs.deps, isAlive: () => false });

  expect(verdict.action).toBe("none");
  expect(fs.removed).toEqual([]);
});

test("形が読めないロックも触らない", () => {
  const fs = fakeFs("なにか");
  const verdict = clearStaleProfileLock("/p", { ...fs.deps, isAlive: () => false });

  expect(verdict.action).toBe("none");
  expect(fs.removed).toEqual([]);
});

test("ロックが無ければ、何もしない（それが正常）", () => {
  const fs = fakeFs(undefined);
  const verdict = clearStaleProfileLock("/p", { ...fs.deps, isAlive: () => false });

  expect(verdict.action).toBe("none");
  expect(fs.removed).toEqual([]);
});
