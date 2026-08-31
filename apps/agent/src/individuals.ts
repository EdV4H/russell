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

/**
 * 支給しうる装備（§9.1）。**個体ごとに違う。**
 *
 * プリセットにも `equipment` という軸が最初からある（番頭は `["slack"]` だけ）。
 * 秘書に会議の装備は要らないし、逆にカレンダーは新人には要らない。
 */
export type EquipmentId = "notion" | "google-drive" | "meeting";

export interface Individual {
  /** 記憶と監査に付く id。**変えない**（変えると過去の記憶と切り離される）。 */
  id: string;
  temperament: Temperament;
  /** env の接尾辞。`SLACK_BOT_TOKEN_<suffix>` を探し、無ければ接尾辞なしを使う。 */
  envSuffix: string;
  /**
   * 支給する装備（§9.1）。
   *
   * > [!IMPORTANT]
   * > **載っていない装備は、組み立てすらしない。** 個体は持っていない能力の
   * > 存在を知らない（§9.2）。「持っているが使わせない」ではなく「持っていない」。
   * >
   * > 載っていても、鍵が無ければプラグイン側が自分で降りる。**支給の意思**と
   * > **支給できるか**は別の話で、ここに書くのは前者である。
   */
  equipment: EquipmentId[];
}

/** 個体1号 Bob（スポンジ）。docs/preparation/initial-data/temperament-unit-01.md の確定値。 */
const BOB: Individual = {
  id: "bob",
  envSuffix: "BOB",
  // いまの Bob が持っているものをそのまま（挙動を変えない）
  equipment: ["notion", "google-drive", "meeting"],
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

/**
 * 個体2号 Walter（番頭）。**特定の人を見て、予定と約束を落とさないようにする。**
 *
 * 名前は Alice and Bob の一覧から取っている。順番が決まっているので名付けで悩まない、
 * という実務上の理由が主だが、Walter はあの一覧で **warden（見張り役）** に当たる——
 * 見守る役割とそのまま重なった。
 *
 * > [!IMPORTANT]
 * > **あの一覧には敵役がいる**（Eve は盗聴者、Mallory は攻撃者、Trudy は侵入者）。
 * > 個体の名前には使わないこと。監査ログに `mallory` が並ぶのは、後から見て笑えない。
 * > 安全な並び: Bob → Walter → Carol → Dave → Faythe → Trent → Peggy → Victor。
 *
 * プリセットは番頭（`docs/preparation/initial-data/presets.md`）。人と締切を覚えている
 * 世話焼きで、自発性が高い代わりに深い専門性を削ってある。
 */
const WALTER: Individual = {
  id: "walter",
  envSuffix: "WALTER",
  // **会議には入らない。** 秘書が同席する必要はなく、装備は少ないほど事故が減る（§9.3）。
  // カレンダーはこれから作る（いまは Drive を読めるだけ）。
  equipment: ["google-drive"],
  temperament: {
    name: "Walter",
    tone: "落ち着いていて手短か。要点から言う。急かさないが、抜けは必ず指摘する",
    backstory: "人と締切を覚えている番頭。予定と約束を落とさないよう、先回りして整える",
    // 番頭は自発性が高い（0.7）。**呼ばれなくても気づいて言う**のが役目だが、
    // 1日の発言量の枠と静音時間で暴走は抑える（§6）
    proactivity: 0.7,
    daily_speak_cap: 5,
    // 好奇心より、人と予定を覚えることに寄せる（プリセットの curiosity 0.6）
    curiosity: 0.6,
    reaction_rate: 0.5,
  },
};

export const INDIVIDUALS: Record<string, Individual> = { bob: BOB, walter: WALTER };

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
