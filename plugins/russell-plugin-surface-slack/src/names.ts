/**
 * Slack の user id → 表示名（#B）。
 *
 * ADR 0008 で「表示名は取り直せるから覚えない」と決めたが、**取り直す手段を作っていなかった**。
 * その結果、個体は相手が誰か分からないまま会話し、実際に**存在しない名前を作った**。
 *
 * ここは取り直す側。記憶には持たない（覚えるのは「一緒に働いて分かったこと」だけ）。
 */

import type { WebClient } from "@slack/web-api";

/** 引いた名前の寿命。表示名は変わりうるが、頻繁ではない。 */
const TTL_MS = 60 * 60 * 1000;

export interface NameResolver {
  /** 会話に出てくる id をまとめて引く。**引けなかった id は返さない**（当てない）。 */
  resolve(ids: Iterable<string>): Promise<Map<string, string>>;
}

/** テキストに出てくる mention の id を拾う（発言者は別途足す）。 */
export function mentionedIds(text: string): string[] {
  return [...text.matchAll(/<@([^>|\s]+)(?:\|[^>]*)?>/g)].map((m) => m[1] as string);
}

export function createNameResolver(client: Pick<WebClient, "users">): NameResolver {
  const cache = new Map<string, { name: string; until: number }>();
  /** 引けなかった id。**毎回叩き直さない**（権限不足なら何度やっても失敗する）。 */
  const missing = new Map<string, number>();
  let warned = false;

  return {
    async resolve(ids: Iterable<string>): Promise<Map<string, string>> {
      const now = Date.now();
      const out = new Map<string, string>();
      const wanted: string[] = [];
      for (const id of new Set(ids)) {
        const hit = cache.get(id);
        if (hit && hit.until > now) {
          out.set(id, hit.name);
          continue;
        }
        if ((missing.get(id) ?? 0) > now) continue;
        wanted.push(id);
      }

      for (const id of wanted) {
        try {
          const res = await client.users.info({ user: id });
          // 呼ばれたい名前を優先する（display_name → real_name → name）
          const p = res.user?.profile;
          const name = p?.display_name || p?.real_name || res.user?.name;
          if (name) {
            cache.set(id, { name, until: now + TTL_MS });
            out.set(id, name);
          } else {
            missing.set(id, now + TTL_MS);
          }
        } catch (err) {
          missing.set(id, now + TTL_MS);
          const detail = err instanceof Error ? err.message : String(err);
          if (!warned) {
            warned = true;
            // **何をすれば直るかまで書く。** missing_scope だけでは運用者が動けない
            console.warn(
              detail.includes("missing_scope")
                ? "[slack] 相手の名前を引くには `users:read` が要ります（Slack アプリに追加して再インストール）。無いと、個体は相手を id でしか認識できません。"
                : `[slack] 表示名を引けませんでした（${id}）: ${detail}`,
            );
          }
        }
      }
      return out;
    },
  };
}
