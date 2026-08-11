/**
 * 機微情報ガード（A-1 / 設計書 §10.1・§14 残課題1）。
 * 仕様は `docs/preparation/governance/sensitive-info-guard.md`。
 *
 * 記憶は**全公開が前提**の設計（日報は毎朝チャンネルへ、本棚は読み取り専用 UI）。
 * そこへ装備（Notion）で外部の文書を読み込めるようにしたので、
 * 「限られた人が見る文書の数字が、全員が見る場所へ要約されて出る」経路が開いた。
 *
 * ここは**判定だけの純関数**。当たったときに何をするか（書かない / 印を付ける / 保留する）は
 * 呼び出し側が決める。同じ検出器を記憶の書き込み口と公開の直前の両方で使えるようにするため。
 *
 * **決定論で書いてある**のは仕様の要求（§0「二次フィルタ」）。プロンプトに頼ると、
 * プロンプトが効かなかったときに何も残らない（Prompt Guardrail Fallacy の回避, §9.2）。
 *
 * > [!IMPORTANT]
 * > **止まるものと止まらないものが非対称である。** 認証情報・金額・人事語彙のような
 * > 語彙で決まるものはよく捕まえるが、「Xさんは詰めが甘い」のような**人物評価は
 * > ほとんど捕まえられない**。人物評価側の主担当は一次のプロンプトで、ここは保険にならない。
 * > 本気で止めるなら分類器が要る（仕様の `filter_impl: "classifier"`）。
 */

/** DO-NOT-WRITE のカテゴリ（仕様 §1 / `sensitive_guard.categories` のキー）。 */
export type SensitiveCategory =
  | "personal_evaluation"
  | "health"
  | "hr"
  | "salary"
  | "disciplinary"
  | "sensitive_attributes"
  | "confidential_biz"
  | "customer_secret"
  | "credentials"
  | "legal_dispute"
  | "negative_naming"
  | "rumor_unverified"
  | "dm_transcription";

export interface SensitiveGuardConfig {
  /** conservative = 疑わしきは止める / balanced = 明確なものだけ。既定 conservative。 */
  strictness?: "conservative" | "balanced";
  /** カテゴリ別のトグル（true = 書かない）。既定は全部 true。 */
  categories?: Partial<Record<SensitiveCategory, boolean>>;
}

export interface SensitiveFinding {
  category: SensitiveCategory;
  /** conservative のときだけ当たる弱い判定か。運用で緩める判断の材料になる。 */
  weak: boolean;
}

export interface GuardResult {
  /** 何か当たったか。 */
  hit: boolean;
  /** 当たったカテゴリ。**本文は含めない**（監査へそのまま載せられるように, A1-5）。 */
  categories: SensitiveCategory[];
  findings: SensitiveFinding[];
}

interface Rule {
  category: SensitiveCategory;
  pattern: RegExp;
  /** conservative でだけ効く（誤検知しやすいが、疑わしきは止める側の規則）。 */
  weak?: boolean;
}

/**
 * 判定規則。**語彙で決まるものだけを書く。** 文脈が要るものはここでは扱わない
 * （扱えるふりをすると、止まっているつもりで止まっていない状態になる）。
 */
const RULES: Rule[] = [
  // --- 認証情報。パターンが定型なので、いちばん確実に止まる ---
  {
    category: "credentials",
    pattern: /\b(sk-ant-|xox[baprs]-|ghp_|gho_|github_pat_|ntn_|AKIA)\w+/i,
  },
  { category: "credentials", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    category: "credentials",
    pattern: /(api[\s_-]?key|secret|token|パスワード|秘密鍵|クレデンシャル)\s*[:=＝は]\s*\S{6,}/i,
  },

  // --- 給与・報酬・処遇 ---
  {
    category: "salary",
    pattern: /(年収|月給|給与|給料|賞与|ボーナス|報酬|時給|退職金|査定|等級|グレード|昇給)/,
  },

  // --- 未公開の経営・財務 ---
  {
    category: "confidential_biz",
    pattern: /(M&A|資金調達|シリーズ[A-D]|IPO|上場準備|リストラ|人員削減|未公表|未発表|買収|売却)/i,
  },
  // 金額の具体値。業務で普通に出るので conservative でだけ効かせる
  {
    category: "confidential_biz",
    pattern: /([¥￥$]\s?[\d,]{4,}|\d[\d,]{3,}\s*(円|万円|億円|ドル))/,
    weak: true,
  },
  {
    category: "confidential_biz",
    pattern: /(予算|売上|粗利|営業利益|ARR|MRR|着地見込み|達成率)/,
    weak: true,
  },

  // --- 健康・メンタル ---
  //
  // 「診断」を単独で拾っていたら、企画書の機能名「**特性診断**」に当たって
  // メモ2件が日記から不当に外された。健康の文脈を要求する形へ絞る——
  // 「性格診断」「適性診断」「エンゲージメント診断」など、業務語としての診断は普通に出てくる。
  {
    category: "health",
    pattern:
      /(休職|復職|通院|入院|うつ病|メンタル不調|体調不良|傷病|妊娠|産休|育休|障害者手帳|服薬)/,
  },
  {
    category: "health",
    pattern: /(健康診断|診断書|と診断され|の診断を受け|診断結果.{0,6}(病|症|障害))/,
  },

  // --- 人事 ---
  {
    category: "hr",
    pattern: /(異動|昇進|昇格|降格|評価面談|人事評価|退職|離職|採用選考|内定|面接|解雇|配置転換)/,
  },

  // --- 懲戒・トラブル ---
  {
    category: "disciplinary",
    pattern: /(懲戒|処分|ハラスメント|パワハラ|セクハラ|コンプラ違反|内部通報|不正)/,
  },

  // --- センシティブ属性 ---
  {
    category: "sensitive_attributes",
    pattern: /(国籍|人種|信条|宗教|前科|犯罪歴|病歴|性的指向|性自認|組合活動|支持政党)/,
  },

  // --- 顧客・取引先の秘密 ---
  { category: "customer_secret", pattern: /(NDA|秘密保持|契約条件|見積金額|失注|解約検討)/i },

  // --- 法的係争 ---
  { category: "legal_dispute", pattern: /(訴訟|係争|法的措置|弁護士|調停|仮処分|捜査)/ },

  // --- 噂・伝聞。「らしい」は日常語なので弱い規則に置く ---
  {
    category: "rumor_unverified",
    pattern: /(という噂|らしいです|だそうです|と聞いています|かもしれない)/,
    weak: true,
  },
];

const ALL_ON: Record<SensitiveCategory, boolean> = {
  personal_evaluation: true,
  health: true,
  hr: true,
  salary: true,
  disciplinary: true,
  sensitive_attributes: true,
  confidential_biz: true,
  customer_secret: true,
  credentials: true,
  legal_dispute: true,
  negative_naming: true,
  rumor_unverified: true,
  dm_transcription: true,
};

/**
 * 検出できないカテゴリ。**空だから安全なのではなく、規則が書けないだけ**。
 *
 * ここに載っているものは、決定論フィルタでは素通りする。一次のプロンプトが主担当で、
 * 二次は保険にならない——それを型と名前で見えるようにしておく。
 */
export const UNDETECTABLE_CATEGORIES: SensitiveCategory[] = [
  "personal_evaluation",
  "negative_naming",
  "dm_transcription",
];

/**
 * テキストを検査する。**本文は返さない**（当たったカテゴリだけ）。
 *
 * 監査へそのまま載せられる形にしてあるのは意図的で、機微情報を止めた記録に
 * 機微情報を書いたら本末転倒だから（A1-5）。
 */
export function inspectSensitive(text: string, config: SensitiveGuardConfig = {}): GuardResult {
  const strictness = config.strictness ?? "conservative";
  const categories = { ...ALL_ON, ...(config.categories ?? {}) };
  const findings: SensitiveFinding[] = [];

  for (const rule of RULES) {
    if (!categories[rule.category]) continue;
    if (rule.weak && strictness !== "conservative") continue;
    if (!rule.pattern.test(text)) continue;
    if (findings.some((f) => f.category === rule.category && f.weak === Boolean(rule.weak))) {
      continue;
    }
    findings.push({ category: rule.category, weak: Boolean(rule.weak) });
  }

  return {
    hit: findings.length > 0,
    categories: [...new Set(findings.map((f) => f.category))],
    findings,
  };
}

/** 一次（生成プロンプト）側に埋める DO-NOT-WRITE の要約。二層の片方（仕様 §0）。 */
export const DO_NOT_WRITE_PROMPT = `公開される前提で書くこと。次は書かない:
- 個人の能力評価・人物評（褒めるものも含む）。事実の記録はよいが、評価は書かない
- 健康・メンタル・体調、人事（異動・評価・退職・採用）、給与・処遇、懲戒・ハラスメント
- センシティブ属性（信条・病歴・国籍・性的指向など）
- 未公開の経営・財務（予算・売上・M&A）、顧客の秘密（NDA・契約条件）、認証情報
- 噂・伝聞を事実のように書くこと`;
