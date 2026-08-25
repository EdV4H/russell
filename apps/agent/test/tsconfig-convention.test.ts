/**
 * ビルド設定の取り決め（ファイルを読むだけ）。
 *
 * **一度これで嵌っている。** tsc は「作り済みか」を `.tsbuildinfo` の時刻だけで判断し、
 * dist が実際にどうなっているかは見ない。記録が dist の外にあると、キャッシュが dist だけを
 * 差し替えても記録は前のまま残り、次のビルドで**何も出力しない**——`--force` を付けても
 * 直らない。修正済みのコードが動いている個体へ届かず、ビルドもテストも通ったままだった。
 *
 * 置き場所は共通設定（`@edv4h/russell-tsconfig`）に閉じてある。ここで見張るのは
 * **新しいパッケージがそこから外れていないか**だけ。外れ方は静かなので、テストで出す。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHARED = "@edv4h/russell-tsconfig/base.json";

/** ワークスペースのパッケージのうち、ビルドするもの。 */
function buildablePackages(): { dir: string; pkg: Record<string, unknown> }[] {
  const found: { dir: string; pkg: Record<string, unknown> }[] = [];
  for (const group of ["packages", "plugins", "apps", "examples"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      const dir = join(ROOT, group, name);
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      if (scripts.build) found.push({ dir, pkg });
    }
  }
  return found;
}

/**
 * tsconfig を読む。**注釈を落としてから**——tsconfig は JSON5 寄りで注釈を書けるし、
 * ここには「なぜこの設定なのか」を書いてある（それを読めない検査に落とされたら本末転倒）。
 *
 * 落とすのは**行頭から始まる注釈だけ**。値の中の `https://` を巻き込まないため。
 */
const read = (path: string) =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;

test("ビルドするパッケージは、全て共通設定を extends している", () => {
  const packages = buildablePackages();
  // 数が0なら、この検査自体が何も見ていない（**測る側が壊れていないこと**を先に確かめる）
  expect(packages.length).toBeGreaterThan(10);

  for (const { dir } of packages) {
    expect(read(join(dir, "tsconfig.json")).extends, dir).toBe(SHARED);
  }
});

test("**出力の置き場所を各パッケージで上書きしない**（共通設定から外れる唯一の道）", () => {
  for (const { dir } of buildablePackages()) {
    const options = (read(join(dir, "tsconfig.json")).compilerOptions ?? {}) as Record<
      string,
      unknown
    >;
    for (const key of ["outDir", "rootDir", "tsBuildInfoFile"]) {
      expect(options[key], `${dir} の ${key}`).toBeUndefined();
    }
  }
});

test("共通設定は、作り済みの記録を dist の中へ置く", () => {
  const options = (read(join(ROOT, "packages/tsconfig/base.json")).compilerOptions ?? {}) as Record<
    string,
    unknown
  >;
  // dist と一緒に消え、一緒に復元される場所であること。ここが外れると静かに壊れる
  expect(options.tsBuildInfoFile).toBe("${configDir}/dist/tsconfig.tsbuildinfo");
  expect(options.outDir).toBe("${configDir}/dist");
});

test("共通設定を使うパッケージは、それを依存に書いている（書き忘れると extends が解決できない）", () => {
  for (const { dir, pkg } of buildablePackages()) {
    const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
    expect(dev["@edv4h/russell-tsconfig"], dir).toBe("workspace:*");
  }
});
