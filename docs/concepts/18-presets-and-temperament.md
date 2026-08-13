# プリセットと気質（Presets & Temperament）

Russell は**素体**（ベースアーキテクチャ）。プリセットを適用して多様なタイプの個体を派生させる
（設計書 [`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §8）。
plugin-first では**プリセット = プラグイン配列 + config の組み立てレシピ**。usketch の `apps/web/app.tsx` が
プラグイン配列を組むのと同じ役割をプリセットが担う（[`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)）。

> [!IMPORTANT]
> プリセットは**性格プロンプトの差分ではない**。認知アーキテクチャの**パラメータ束 + 育ち方の方針 + 装備**の3点セット。
> 挙動の違いは演技ではなく**構造**から生まれる。

## パラメータ軸（§8.1）

各軸が具体的な実装先（＝どのプラグインを、どの config で配列に並べるか）に対応する。

| 軸 | 実装先 |
|---|---|
| 賢さ | モデル選択（Haiku/Sonnet/Opus）・推論の深さ → `model-claude` の config |
| 素直さ | 質問閾値（確信度がこれを下回ったら自力で粘らず人に聞く） |
| 好奇心 | 本棚昇格ポリシー（広く浅く ↔ 狭く深く）・focus_shelves → 記憶プラグイン config |
| 記憶力 | 忘却率 λ（[`12-memory-system.md`](./12-memory-system.md)） |
| 成長方針 | 夜間バッチの playbook 投資（幅優先 ↔ 深さ優先）・対象ドメイン |
| 自発性 | 気づき閾値・発言上限・トリガー種別 → `finding-*` の登録と config |
| 装備 | 初期支給される Equipment（[`14-equipment.md`](./14-equipment.md)。最小権限の実装と一体） |

> [!NOTE]
> **全パラメータ最大は「良い同僚」にならない。** 全部できる個体は人っぽくない。
> どこを削り、その弱さをどの行動で補償させるかがプリセット設計の本体（例:賢さを削って素直さで補償）。

## プリセット = 組み立てレシピ

プリセットは「どのプラグインを、どの config で、どの順序で配列に並べるか」を決める。
配列順は load-bearing（provider を consumer より前に。[`10-plugin-architecture.md`](./10-plugin-architecture.md)）。

```
編集者プリセット → [
  memory-pg({ decay_lambda: 0.02, shelf_policy: "deep", focus_shelves: [...] }),
  model-claude({ model: "sonnet", ask_threshold: 0.6 }),
  equipment-notion(...), equipment-github(...),   // "notion.write", "github.docs.pr"
  surface-slack(...),
  finding-decision-detected(...), finding-doc-drift(...),   // proactivity トリガー
]
```

個体の起動は `createAgent(config, plugins[])`（[`../reference/31-core-api.md`](../reference/31-core-api.md)）。
プリセットの書き方は [`../guides/24-defining-a-preset.md`](../guides/24-defining-a-preset.md)。

## 初期プリセットラインナップ（§8.3）

| プリセット | ひとことで | 特徴的なパラメータ | 育つ先 |
|---|---|---|---|
| スポンジ | 頭は良くないが素直、わからなければすぐ聞く | Haiku・質問閾値高・好奇心 0.9・λ 低・幅優先 | 半年後にドメインのよろず相談役 |
| 編集者 | 仕様を渡すとまとめてドキュメントを更新 | Sonnet・狭く深い本棚・doc 系装備を支給 | ドメインエキスパート兼ドキュメントの番人 |
| 番頭 | 人と締切を覚えている世話焼き | エンティティ中心の記憶・自発性高・リマインド習慣 | チームの潤滑油 |
| 石橋 | 確信がないと動かない慎重派 | HITL 多め・λ 最低・自発性低 | リリース・監査の番人 |

## 気質（temperament、§6.1）

人格の作り込みと自発性の積極度は、別々のハードコードではなく単一の「気質」設定として持つ。
値は**人格プロンプトの生成**と**気づきモジュールの閾値**の両方に流れ込む。

```json
// temperament の例（個体ごとに1つ）
{
  "name": "Bob",
  "tone": "丁寧だが硬すぎない。絵文字は控えめ",
  "backstory": "データ分析が得意な入社1年目",
  "proactivity": 0.6,
  "daily_speak_cap": 3,
  "curiosity": 0.5,
  "reaction_rate": 0.7
}
```

- 人格プロンプトは起動時に temperament から生成する（テンプレート + 値の埋め込み）。人格の深さは値を足すだけで調整可能
- `daily_speak_cap` / `proactivity` は気づきの閾値・発言上限へ流れる（[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)）
- コールドスタート時の `interests` は役割定義（システムプロンプト）からシード。以降は日記から成長する

> [!IMPORTANT] **決定（2026-08-13）**
> **気質は値を「埋め込む」のではなく、段階に落として文章にする。**
> `reaction_rate: 0.7` とプロンプトに書いても、モデルがどう動くかは誰にも言えない。
> 判定のチューニング（[`13-surfaces.md`](./13-surfaces.md)）で分かったのは、
> **効くのは数値ではなく言葉**だということである。
>
> したがって帯（低 / 既定 / 高）で扱い、**既定の帯では何も足さない**——
> 実測して落ち着いた文面をそのまま使い、外れたときだけ一行足す。
> 0.63 と 0.71 の差を言葉にできない以上、細かく効かせるふりをしない。
>
> **返信の長さ（`verbosity`）だけは数値にしない。** 兄弟の値は閾値へ流れるので数値が要るが、
> これはプロンプトの文章になるだけである。段階（`brief` / `normal` / `detailed`）で持ち、
> 省略時は `normal`（既に動いている個体の振る舞いを変えない）。
>
> **決定論の分岐は気質で変えない。** 名指しと1対1は `reaction_rate` が 0 でも返す——
> **直接呼ばれて黙る個体は、気質ではなく故障に見える**。気質が動かすのは、
> 曖昧なときの傾きだけである。
>
> **実行時に変えられるようにはしない。** 温度感をつまみで回せると、人格が
> 「いつでも書き換えられる設定」になる。ここは下書き → 公開の
> `config_version`（下記）に乗せる。**変えたいなら版を発行する**、が答えである。

> [!NOTE]
> **いま何で動いているかは、起動の監査から読む。** 気質はコードにあって DB には無いので、
> リポジトリを読んでも「動いている個体がその版で再起動済みか」は分からない。
> 起動時に `agent.started` へ気質と `config_version` を残し、ビューアの「個体」が
> **直近の1件**を出す。**古い値が出ることもあるが、それが事実**である
> （変えたのに再起動していない、という状態こそ見えるべき）。

### channel_settings（チャンネル別上書き）

`channel_settings` で「雑談チャンネルでは饒舌、実務チャンネルでは控えめ」を表現する。temperament をチャンネル単位で上書きする。
変更は `/russell config` コマンド（管理者のみ）から。変更履歴は `event_log` へ。テーブル定義は [`19-data-model.md`](./19-data-model.md)。

## config_version の公開版方式（§6.1、Frank v2 から採用）

> [!IMPORTANT]
> temperament・プリセット・ルーティン等の設定は**下書き → 公開の2段階**。
> 公開ごとに**不変の `config_version`** を発行し、各実行（会話・習慣・気づき）は開始時に版を pin して使用版を記録する。
> 実行途中で設定が変わっても、1回の実行内で版が混ざらない。**ロールバック = 過去版の再公開**。

`runtime.configVersion` は実行開始時に pin される（[`../reference/31-core-api.md`](../reference/31-core-api.md)）。
Finding にも `config_version` が記録され、「どの設定版で出た気づきか」の再現性を担保する。

## 記憶の個体間分離（§8.4）

**記憶は個体間で共有しない（決定事項）。** 各個体の本棚・日記・playbook は完全に独立
（[`12-memory-system.md`](./12-memory-system.md)）。分離しているからこそ、将来の2個体ディスカッション機能（P4）に
本物の視点差が生まれる（同じ記憶を見る2体の議論は同じ結論に収束するだけで無意味）。

## 関連

- プリセット定義ガイド：[`../guides/24-defining-a-preset.md`](../guides/24-defining-a-preset.md)
- コアAPI（`createAgent` / `AgentConfig`）：[`../reference/31-core-api.md`](../reference/31-core-api.md)
- データモデル（`agents` / `temperament` / `channel_settings`）：[`19-data-model.md`](./19-data-model.md)
