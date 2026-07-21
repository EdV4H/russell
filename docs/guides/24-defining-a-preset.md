# ガイド: プリセットを定義する（プラグインの組み立て）

usketch では `apps/web/app.tsx` がプラグイン配列を組む。Ryo ではその役割を**プリセット**が担う。
プリセットは個体を起動するときに「**どのプラグインを・どの config で・どの順に**」配列へ並べ、`createAgent` に渡す組み立てレシピだ。

前提: [`../concepts/10-plugin-architecture.md`](../concepts/10-plugin-architecture.md)、契約 [`../reference/30-ryo-plugin-contract.md`](../reference/30-ryo-plugin-contract.md)、ライフサイクル [`../reference/31-core-api.md`](../reference/31-core-api.md)。

> [!NOTE] 提案仕様
> コードは docs-only 段階の提案。型は実装時に `@edv4h/ryo-shared` / `@edv4h/ryo-core` で確定する。

## プリセットとは何か（そして何でないか）

設計書 §8 のとおり、プリセットは**性格プロンプトの差分ではない**。認知アーキテクチャの:

1. **パラメータ束** — 賢さ（モデル選択）・素直さ（質問閾値）・好奇心・記憶力（忘却率 λ）・自発性。
2. **育ち方の方針** — 夜間バッチの playbook 投資（幅優先 ↔ 深さ優先）と対象ドメイン。
3. **装備（equipment）** — 初期支給される道具。最小権限の実装と一体。

の3点セットだ。挙動の違いは**演技ではなく構造から**生まれる。

**設計原則: 全パラメータ最大は「良い同僚」にならない。** どこを削り、その弱さをどの行動で補償させるか（例: 賢さを削って素直さで補償）がプリセット設計の本体。

## 組み立ての形

プリセットは temperament（§6.1）と、それを反映したプラグイン配列を返す。配列順は load-bearing（provider → consumer）なので、推奨並び順 `services/memory → models → equipment → surfaces → routines → findings` に従う。

```ts
// apps/agent/presets/editor.ts
import { createAgent } from "@edv4h/ryo-core";
import { createPgMemoryPlugin } from "@edv4h/ryo-plugin-memory-pg";
import { createClaudeModelPlugin } from "@edv4h/ryo-plugin-model-claude";
import { createNotionEquipmentPlugin } from "@edv4h/ryo-plugin-equipment-notion";
import { createGithubDocsEquipmentPlugin } from "@edv4h/ryo-plugin-equipment-github-docs";
import { createSlackSurfacePlugin } from "@edv4h/ryo-plugin-surface-slack";
import type { Temperament } from "@edv4h/ryo-shared";

const editorTemperament: Temperament = {
  name: "詩織",
  tone: "落ち着いた敬語。要点を先に言う",
  backstory: "仕様を渡すとドキュメントを育てるドメインエキスパート",
  proactivity: 0.5,
  daily_speak_cap: 3,
  curiosity: 0.4,
  reaction_rate: 0.6,
};

export function assembleEditor(agentId: string, configVersion: string) {
  return createAgent(
    { agentId, configVersion, temperament: editorTemperament, mode: "dryrun" },
    [
      // ── provider を前に ──
      createPgMemoryPlugin({
        decayLambda: 0.02,          // 記憶力: 深い棚（忘れにくい）
        shelfPolicy: "deep",        // 狭く深い本棚
        focusShelves: ["仕様", "決定事項", "用語集"],
      }),
      createClaudeModelPlugin({ model: "sonnet" }),   // 賢さ: Sonnet
      // ── 装備（最小権限で支給） ──
      createNotionEquipmentPlugin({ scopes: ["docs.write"] }),
      createGithubDocsEquipmentPlugin({ repo: "edv4h/ryo", scopes: ["docs.pr"] }),
      // ── surface ──
      createSlackSurfacePlugin({ /* … */ }),
      // ── findings は surface より後（emit を購読するため） ──
      // createDecisionDriftFindingPlugin(), 等
    ],
  );
}
```

## worked example: 「編集者」プリセット

仕様を伝えるとドキュメントを育てるドメインエキスパート（設計書 §8.2）。パラメータ束をプラグイン config へ写す:

| 軸 | 値 | 実装先プラグイン / config |
|---|---|---|
| 賢さ | Sonnet | `model-claude`（`model: "sonnet"`） |
| 素直さ | 質問閾値 0.6 | 認知ループ config（`ask_threshold`） |
| 好奇心 | 0.4（狭く） | `memory-pg`（`shelfPolicy: "deep"`, `focusShelves`） |
| 記憶力 | λ = 0.02（**深い棚 = 忘れにくい**） | `memory-pg`（`decayLambda: 0.02`） |
| 成長方針 | depth（product-spec / documentation） | 夜間バッチ config（`investment: "depth"`） |
| 自発性 | 0.5（意思決定検知・矛盾検知） | temperament + finding プラグイン群 |
| 装備 | Slack・Notion(write)・GitHub docs PR | `surface-slack` + `equipment-notion` + `equipment-github-docs` |

`decay_lambda=0.02` は忘却曲線 `strength ← strength × exp(-λ × days)`（設計書 §3.4）の λ を小さくする＝**深い棚（deep shelf）**で、仕様・決定事項・用語集を長く保持する。スポンジ（幅優先・λ 大）と対照的に、編集者は狭く深く覚える。

「編集者」の挙動として現れるもの: スレッドで仕様が決まったのを検知して「ドキュメントに反映しておきますね」→ Notion 更新 or docs PR 作成（HITL 承認つき）。過去の決定との矛盾を見つけると「先週の決定と食い違っていますが、どちらが正ですか?」と聞き返す。用語集の棚を勝手に育てる。**これらはすべてプラグイン config の帰結であって、人格プロンプトの作文ではない。**

## config_version でピンする

temperament・プリセット・ルーティン等の設定は**下書き → 公開の2段階**（Frank v2 方式、設計書 §6.1）。公開ごとに不変の `config_version` を発行し、各実行（会話・習慣・気づき）は開始時に版を pin する。

- 実行途中で設定が変わっても、1回の実行内で版が混ざらない。
- ロールバック = 過去版の再公開。
- Finding や事前承認は `config_version` を記録するので「どの設定版で出た気づきか」を後から再現できる。

プリセットを編集したら新しい `config_version` を発行し、`createAgent` の `AgentConfig.configVersion` に渡す。装備のスコープ付き事前承認もこの版に紐づく（[`22-authoring-equipment.md`](./22-authoring-equipment.md#スコープ付き事前承認)）。

## 初期ラインナップとの対応

| プリセット | 削る軸 → 補償 | 特徴的な config | 装備の例 |
|---|---|---|---|
| スポンジ | 賢さ → 素直さ | Haiku・質問閾値低・好奇心 0.9・λ 大・幅優先 | Slack のみ |
| 編集者 | 好奇心（狭く） → 深さ | Sonnet・λ 0.02・deep 棚 | Slack・Notion・GitHub docs |
| 番頭 | — → エンティティ記憶 | 自発性高・リマインド習慣 | Slack・カレンダー |
| 石橋 | 自発性 → HITL | λ 最低・HITL 多め・自発性低 | Slack・GitHub（承認多め） |

各プリセットは同じプラグイン群を**違う config と違う配列**で組むだけ。新しいプリセットの追加はコアもプラグインも変更しない。

## チェックリスト

- [ ] パラメータ束 → プラグイン config へ写している（人格プロンプトの作文にしていない）
- [ ] 配列順が provider → consumer（`services/memory → models → equipment → surfaces → routines → findings`）
- [ ] 装備は最小権限で支給（`scopes` を絞る）
- [ ] `config_version` を発行して `createAgent` に渡している
- [ ] 「どこを削り何で補償したか」を説明できる
