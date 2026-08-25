/**
 * Chrome のプロファイルに残るロックの後片付け（#130）。
 *
 * Chrome は同じプロファイルを2つのプロセスで開かせない。見張りは `SingletonLock` という
 * シンボリックリンクで、中身は `ホスト名-pid`。**持ち主が死んでいれば Chrome 自身が
 * 奪い取る**はずだが、実際には「既存のブラウザ セッションで開いています」と言って
 * 起動しないことがある（そして人は毎回アクティビティモニタを見にいく羽目になる）。
 *
 * > [!IMPORTANT]
 * > **このプロファイルは個体専用である。** 人が使うブラウザとは別物で、他に開く者はいない。
 * > だから「持ち主が死んでいるロック」は掃除してよい——共用のプロファイルなら、
 * > 消した瞬間に動いている Chrome のデータを壊すので、絶対にやってはいけない。
 * >
 * > **生きているなら消さない。** 死んでいることを確かめられたときだけ消す。
 * > 確かめられない（別のホストが持ち主、形が読めない）なら、触らない。
 */

import { execFileSync } from "node:child_process";
import { readlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** ロックの持ち主。読めなければ `undefined`（**当てにいかない**）。 */
export interface LockOwner {
  host: string;
  pid: number;
}

/** `ATR-LAP-OSX-…-60615` を持ち主に直す。**末尾の数字が pid**、その前がホスト名。 */
export function parseLockOwner(target: string): LockOwner | undefined {
  const m = /^(.*)-(\d+)$/.exec(target.trim());
  if (!m?.[1] || !m[2]) return undefined;
  const pid = Number(m[2]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { host: m[1], pid };
}

/** 同じ機械か。`.local` の有無や大文字小文字で取り違えない。 */
export function sameHost(a: string, b: string): boolean {
  const norm = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/\.local$/, "");
  return norm(a) === norm(b);
}

/** 掃除の結果。**何をしたか（しなかったか）を言えるようにする。** */
export type LockVerdict =
  | { action: "none"; reason: string }
  | { action: "cleared"; pid: number; why: string }
  | { action: "held"; pid: number; holder: string };

export interface ClearLockDeps {
  readLink?: (path: string) => string;
  unlink?: (path: string) => void;
  isAlive?: (pid: number) => boolean;
  /** その pid が何のプロセスか。読めなければ `undefined`（**当てにいかない**）。 */
  processName?: (pid: number) => string | undefined;
  host?: string;
}

/**
 * その pid の正体。**pid が生きているだけでは足りない。**
 *
 * macOS は pid を使い回す。数時間前のロックに書かれた pid が、いまはまったく別の
 * プロセスであることは普通にある。そこを見ないと「生きている」と判定し続けて、
 * **再起動するまで永久に会議へ入れない**（実際そうなった）。
 */
export function processName(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return undefined;
  }
}

/** Chrome か。名前で見る（`…/Google Chrome` `chromium` など）。 */
export function looksLikeChrome(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("chrome") || n.includes("chromium");
}

/** そのプロセスが生きているか。**シグナルは送らない**（0 は存在確認だけ）。 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「いるが触れない」＝生きている
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * 死んでいるロックだけを片付ける。
 *
 * 返すのは**やったこと**で、呼び出し側はそれをログに出す。黙って消すと、
 * 「なぜか動いた／動かない」の理由が誰にも見えなくなる。
 */
export function clearStaleProfileLock(profileDir: string, deps: ClearLockDeps = {}): LockVerdict {
  const readLink = deps.readLink ?? readlinkSync;
  const unlink = deps.unlink ?? unlinkSync;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const host = deps.host ?? hostname();

  let target: string;
  try {
    target = readLink(join(profileDir, "SingletonLock"));
  } catch {
    return { action: "none", reason: "ロックはありません" };
  }

  const owner = parseLockOwner(target);
  if (!owner) return { action: "none", reason: `ロックの形が読めません（${target}）` };
  // **別の機械が持ち主なら触らない。** こちらからは生死を確かめようがない
  if (!sameHost(owner.host, host)) {
    return { action: "none", reason: `別の機械が持っています（${owner.host}）` };
  }
  const name = (deps.processName ?? processName)(owner.pid);
  let why: string | undefined;
  if (!isAlive(owner.pid)) {
    why = "プロセスが不在です";
  } else if (name !== undefined && !looksLikeChrome(name)) {
    // **pid の使い回し。** 生きてはいるが Chrome ではない＝このロックは古い
    why = `pid が別のプロセスに使い回されています（${name}）`;
  } else {
    // 生きていて Chrome、または正体が読めない。**触らない**（判断は人に渡す）
    return { action: "held", pid: owner.pid, holder: name ?? "正体不明" };
  }

  // 持ち主はもういない。**Singleton 系だけ**を消す（プロファイルの中身には触らない）
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      unlink(join(profileDir, name));
    } catch {
      // 無ければそれでよい
    }
  }
  return { action: "cleared", pid: owner.pid, why };
}
