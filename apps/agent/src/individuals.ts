/**
 * どの個体を立ち上げるか（§8）。
 *
 * 組み立てホストは長らく Bob 決め打ちだった。**2人目を置く場所が無かった**ので、
 * ここで個体を選べるようにする。設計上、個体は最初から複数を想定している——
 * 記憶は `agent_id` で完全に分かれ（§8.4）、通信面は個体ごとに別アプリ（B-2 決定）、
 * Google は**リフレッシュトークンだけ**が個体ごとになる。
 *
 * > [!IMPORTANT]
 * > **鍵は個体ごとに分ける。** `SLACK_BOT_TOKEN_HANA` のように接尾辞で持ち、
 * > 無ければ接尾辞なしへ落ちる（1体だけで動かしている間は今までどおり）。
 * > **他の個体の鍵を掴まない**ことが要点で、同じトークンを共有すると
 * > 2つの個体が同じ名前で喋り、どちらの発言か分からなくなる。
 */

import type { Temperament } from "@edv4h/russell-shared";

export interface Individual {
  /** 記憶と監査に付く id。**変えない**（変えると過去の記憶と切り離される）。 */
  id: string;
  temperament: Temperament;
  /** env の接尾辞。`SLACK_BOT_TOKEN_<suffix>` を探し、無ければ接尾辞なしを使う。 */
  envSuffix: string;
}

/** 個体1号 Bob（スポンジ）。docs/preparation/initial-data/temperament-unit-01.md の確定値。 */
const BOB: Individual = {
  id: "bob",
  envSuffix: "BOB",
  temperament: {
    name: "Bob",
    tone: "丁寧だが硬すぎない。明るく前向き。わからないことは素直に聞く。絵文字は控えめ",
    backstory: "好奇心旺盛で、何でもスポンジのように吸収する新人。半年後にジェネラリストへ",
    proactivity: 0.3,
    daily_speak_cap: 3,
    curiosity: 0.9,
    reaction_rate: 0.7,
  },
};

export const INDIVIDUALS: Record<string, Individual> = { bob: BOB };

/**
 * どの個体か。既定は Bob（今までどおり）。
 *
 * **知らない名前は落とす。** 打ち間違いを既定へ倒すと、**別の個体のつもりで
 * Bob の記憶に書き込む**——後から分離できない。
 */
export function resolveIndividual(raw: string | undefined): Individual {
  const id = (raw ?? "bob").trim().toLowerCase();
  const found = INDIVIDUALS[id];
  if (!found) {
    throw new Error(
      `RUSSELL_AGENT="${raw}" は知らない個体です（${Object.keys(INDIVIDUALS).join(" / ")}）。打ち間違いを既定へ倒すと、別の個体のつもりで既存の記憶へ書き込むことになります。`,
    );
  }
  return found;
}

/**
 * その個体の鍵を読む。**接尾辞つきを優先し、無ければ接尾辞なし**へ落ちる。
 *
 * 1体だけで動かしている間は今までの env がそのまま効き、2体目を足すときだけ
 * 接尾辞つきを用意すればよい——**動いているものを壊さずに増やせる**。
 */
export function secretFor(name: string, individual: Individual): string | undefined {
  return process.env[`${name}_${individual.envSuffix}`] ?? process.env[name];
}
