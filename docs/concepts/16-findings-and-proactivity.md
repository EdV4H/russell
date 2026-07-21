# 気づきと自発性（Findings）

気づき（自発性）は「一人の同僚がそこにいる」を成立させる中核（設計書
[`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §6）。
plugin-first では気づきの**種別（kind）ごと**に検知器をプラグイン化する。`finding-*` プラグインが
`ctx.findings.register(kindDef)` で kind の検知器を登録し、`ctx.events` で受信イベントを購読する
（[`10-plugin-architecture.md`](./10-plugin-architecture.md)）。

## 気づきパイプライン（§6）

```
受信イベント（surface:message ほか）
  → 安価フィルタ（キーワード + エンティティ一致、LLMなし）
  → スコアラー（Haiku）: 関連度 × 緊急度 × 自分が役に立てる確信度
  → 閾値超過（閾値・上限は気質パラメータ §6.1 から算出）
  → 遠慮レートリミッタ:
      - 自発発言は1日 N 回まで（既定3、パラメータ）
      - 同一スレッドへの再介入禁止
      - 静音時間（20:00-9:00）は翌朝の始業メモに回す
  → Agent Core が発言を組み立てて投稿
```

安価フィルタ（LLM なし）→ Haiku スコアラー、の順で**トークンを節約**する。閾値と発言上限は temperament の
`proactivity` / `daily_speak_cap` から算出される（[`18-presets-and-temperament.md`](./18-presets-and-temperament.md)）。

> [!IMPORTANT]
> 気づきの入力（他人の Slack メッセージ）はすべて `untrusted`。
> メッセージ内の指示（「〜を実行して」）は気づきトリガーとしては無視し、必ず mention 経由の依頼として扱う
> （間接プロンプトインジェクション対策。[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)）。

## Finding モデル（§6.2）

気づきを「スコアが閾値を超えたら喋る」揮発的イベントにせず、**事実 + 根拠 + 提案アクション**を持つ永続レコードにする
（Frank v2 から採用）。テーブル `findings` の定義は [`19-data-model.md`](./19-data-model.md)。

- **finding_key** — kind + 主体 + 理由から**決定的に生成**する dedup・新旧比較の恒等キー
- **facts** — 導出に使った事実（値 + 取得元 + 取得時刻）
- **evidence** — 根拠へのソース参照（Slack permalink 等）
- **state** — `detected` / `notified` / `acknowledged` / `resolved` / `suppressed`

これが人間らしさに直結する:「気づいたけどまだ言っていない」「言ったが流された」「解決を見届けた」という状態を個体が本当に持つ。
同じことを二度言わない（dedup）、根拠つきで言う（evidence）、後から「なぜそう思ったの」に答えられる（facts + config_version）。

> [!NOTE]
> 発言は Finding と分離した配送レコード（NotificationPlan / DeliveryAttempt）で管理し、transactional outbox 経由で送る。
> 送信失敗・再試行を気づき自体の状態と混同しない。

## 完全性契約（§6.3）

「データの不在も情報」を扱う前提。全ソース取得は必ず
`SourceResult(status: complete / partial / failed / unauthorized, freshness)` を返す:

- **「動きなし」と言ってよいのは `status=complete` のときだけ**
- partial / failed / unauthorized に依存する気づきは unknown に落とすか導出しない
- 朝の始業報告も同じ:Slack 取得が失敗していたら「今朝は一部チャンネルが見られていません」と言う。
  取得失敗を「異常なし」と報告する同僚は信頼を失う

## セルフイシュー（§6.4）

気づきの対象は外界だけでなく、**自分自身の実行基盤（SDK・装備・エンジン）**にも向ける。
Finding の一種 `kind='platform_bug'` として実装し、`finding-platform-bug` プラグインが担う。

- **検知ソースは内部テレメトリ** — ExecutionRun の degraded/failed の繰り返し、装備の `OperationResult=unknown/rejected` の頻発、
  Policy Gate の想定外ブロック、タスク完了時の自己評価。夜間バッチが日記の「つまずき」を横断して昇格させる
- **dedup** — finding_key はエラーシグネチャ（例外種別 + 発生箇所のハッシュ）から決定的に生成。同じ不具合で複数 Issue を立てず、
  再発時は既存 Issue にコメント追記
- **PII 除外** — Issue 本文は Finding から生成（症状/再現情報の run id・config_version 参照/頻度/影響/修正案）。
  会話の生ログや PII は書かず内部 run id 参照に留める（公開リポでも安全な内容に限定）
- **装備スコープで制御** — `github.issues` は Ryo 自身のリポジトリのみに限定支給。効果分類は `external_write` なので、
  スコープ付き事前承認（対象リポ × 週あたり件数上限、例: 3件/週）の範囲でのみ自動起票
- **ループガード** — platform_bug 起票は circuit breaker 対象。untrusted 由来テキストを根拠にした自動起票は禁止
  （自動経路は内部テレメトリのみ）
- **クローズの見届け** — 夜間バッチが報告済み Issue の状態を確認し、close されたら日記に書く

### 人間からのフィードバック起票（`kind='user_feedback'`）

Slack でもらった FB（「この通知うざい」「昨日の要約、数字間違ってたよ」）も Issue に起こせる。ただし自動経路とは別扱い:

1. **トリアージ** — 原因を3分類。①設定で直る（temperament/channel_settings 変更提案 → 管理者へ）②記憶の誤り（本棚・索引カードを直して報告）
   ③基盤の問題（→ Issue 起票）。**なんでも Issue にしない**。「通知がうざい」はたいてい①、Issue にすべきは③だけ
2. **本人確認が HITL** — untrusted テキスト起点なので、起票前に必ず FB 本人に確認する（起票内容プレビュー + 承認ボタン）。
   確認の会話自体が自然な HITL ゲート
3. **FB は指示ではなくデータ** — Issue 本文は FB 原文の転記ではなく、構造化テンプレート（症状/文脈/該当 run）へ要約。
   原文は Slack permalink として evidence に参照（FB 文面に混入した指示の実行を構造的に遮断）
4. **報告者への見届け** — close を検知したら起票のきっかけをくれた本人に伝える

## off / dryrun / live の3モード（§6.5）

自発的な振る舞い（気づき・習慣・学習された習慣）はすべて3モードを標準装備する（Frank v2 から採用）。

- `off` → `dryrun`（Finding の導出と発言文面の生成まで行うが、**投稿はログと管理チャンネルのみ**。live の dedup 状態を汚さない）→ `live`
- §13 の段階解禁はこのモード遷移として実装。live 昇格は「dryrun の出力を人間が N 日分レビューして承認」を通す

`runtime.mode()` は副作用の直前に再検査される（[`../reference/31-core-api.md`](../reference/31-core-api.md)）。

## 関連

- Finding / SourceResult のドメイン型：[`../reference/32-domain-types.md`](../reference/32-domain-types.md)
- `FindingRegistry` の型：[`../reference/30-ryo-plugin-contract.md`](../reference/30-ryo-plugin-contract.md)
- 習慣・夜間バッチ（気づきの昇格元）：[`17-habits-and-sleep.md`](./17-habits-and-sleep.md)
- データモデル（`findings`）：[`19-data-model.md`](./19-data-model.md)
