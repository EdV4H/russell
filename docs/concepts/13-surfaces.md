# 通信面（Surfaces）

**Russell の本質は「記憶を構成物として持つ個体がそこにいる」ことであって、それがどの面に現れるかは本質ではない**
（[`../design/plugin-first-reinterpretation.md`](../design/plugin-first-reinterpretation.md)）。
通信面（surface）はコアから剥がしてプラグインにする。**Slack は `surface` プラグインの一実装にすぎない。**

元設計書 [`../design/human-like-agent-design.md`](../design/human-like-agent-design.md) §2・§10 は「Slack 常駐」を前提に書かれているが、
本リポジトリでは §10 の内容を `@edv4h/russell-plugin-surface-slack` の仕様として読む。

## surface とは

`SurfaceDefinition` は3つの責務を持つ（[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)）:

- **受信** — `start(sink)` で正規化した受信イベントをコアへ流す購読を開始
- **送信** — `send(out)` でスレッド/宛先へ発話。冪等キー対応
- **HITL** — `requestApproval(req)` で承認要求を提示し結果を待つ

surface プラグインは `ctx.surfaces.register(def)` で自己分類する。コアは surface の種類（Slack か CLI か）を知らない。

> [!NOTE]
> 受信は `ctx.events` に `surface:message` として emit され、`finding-*` 等が購読する。
> emit をリプレイしないので、購読側は surface より**後**に setup する順序制約がある
> （[`10-plugin-architecture.md`](./10-plugin-architecture.md)「配列順は load-bearing」）。

## Slack surface（§10）

`@edv4h/russell-plugin-surface-slack` は数ある surface の1つ。設計書 §10 の仕様をそのまま実装する。

- **Bolt for JavaScript / Socket Mode** — サーバーの inbound 開放不要。スケール要件が出たら HTTP Events API へ移行
- **購読** — `app_mention`, `message.im`, 参加チャンネルの `message.channels`
- **応答は原則スレッド内**。HITL 承認は **Block Kit ボタン**（承認/却下 + 理由入力）
- **最小スコープ** — `app_mentions:read`, `channels:history`, `im:history`, `chat:write`, `reactions:write`
- **記憶操作は通信面の仕事ではない** — 「覚えておいて」「忘れて」の解釈はコア側でモデルが行う
  （[ADR 0003](../adr/0003-model-decides-what-to-remember.md)）。通信面は本文を正規化して渡すだけ

透明性のための出力先も Slack surface が担う: 日記の `#<個体名>-日報` 投稿、メモ取得時の「📝 メモしました」リアクション（§10.1）。

> [!NOTE]
> リアクションは契約上 `react?(req)` で、**コアは意味（`kind: "noted"`）だけを渡す**。何で表すかは通信面の裁量で、
> Slack は 📝、CLI は1行の出力にしている。任意メソッドなので、対応しない通信面ではメモだけ成立して何も起きない。
> 付け先は `contextId`（スレッド単位）ではなく `messageId`（発言単位）。

### スレッド追従（mention 無しで会話を続ける）

mention された発言だけを拾うと、スレッドの2発目以降が無反応になり会話が成立しない
（実地で繋いだ初日に踏んだ）。そこで **Bob が発言したスレッドの続きだけ**を拾う。

Slack のイベント購読は**種類単位でしか絞れない**ので、`message.channels` / `message.groups` を
購読すると参加チャンネルの全発言がプロセスに届く。届いたものをどこまで扱うかで絞る:

| 捨てるもの | 理由 |
|---|---|
| 除外指定したチャンネル | 居させたいが会話には入ってほしくない場所 |
| スレッド外の発言 | チャンネルの雑談を拾い始めると「全部読んでいる」になる |
| Bob がまだ発言していないスレッド | 呼ばれてもいない会話に入っていかない |
| mention を含む発言 | `app_mention` でも届く。両方処理すると2回返信する |
| bot 自身の発言 / `subtype` 付き | 自分に返事を続けない |

> [!IMPORTANT]
> **決定（2026-08-10）: opt-in の実体は Slack の招待。env への登録は求めない。**
> privacy-and-memory-policy の「**明示的に招待され**、かつ台帳登録されたチャンネルのみ」の
> 前半がそのまま opt-in として機能する——Slack は参加していないチャンネルのイベントを配らないし、
> 招待は人が Slack 上で行う明示的な行為だから。
>
> 当初はチャンネル allowlist を必須にしたが、**allowlist はデータの到着を止めていない**
> （購読は種類単位でしか絞れないので、参加チャンネルの発言は指定の有無に関わらず届く。
> 止まるのは処理だけ）。招待以上の安全を買えていないのに、招待のたびに設定と再起動を
> 強いることになるので既定から外した。実際に使う人はやらない。
>
> 代わりに `RUSSELL_SLACK_EXCLUDE_CHANNELS` で**除外**できる（居させたいが会話には
> 入ってほしくないチャンネル用）。厳格に絞りたい場合の allowlist `RUSSELL_SLACK_CHANNELS`
> も残してある。将来 `channel_settings` 台帳が入ったら、管理者の面はそちらへ移す。
>
> 発注書の「`message.channels` 全読みは P0 不要」は**全読み**を外したもので、この形は
> それに反しない。気づきモジュール（§6.2, P3）が全発言を必要とするときに、改めて
> 台帳とレートリミッタとセットで判断する。

「Bob が発言したスレッド」は surface プラグインが `send()` を見て覚える。プロセス内にしか
持たないので再起動で消えるが、**知らないスレッドに発言が来たら Slack に聞き直す**——
`conversations.replies` を取って Bob の発言が含まれていれば、会話に戻る
（[ADR 0001](../adr/0001-conversation-context-from-slack.md)）。会話の中身も同じ経路で
復元するので、**再起動もデプロイも会話を切らない**。Bob の起動前からあるスレッドでも、
mention されれば流れを踏まえて答えられる。

参加していないと分かったスレッドは覚えておき、毎回 API を叩かない。

### Slack の「AI agent」面は採らない

> [!IMPORTANT]
> **決定（2026-08-10）: Slack の AI agent 機能（split view・suggested prompts）は使わない。**
> チャンネルでの `app_mention` 応答を Bob の居場所とする。技術的な排他ではなく（両立できる）、
> **どちらの姿を目指すかの選択**として決めた。
>
> AI agent 面は「サイドパネルで呼び出して使うアシスタント」の UX で、suggested prompts はその象徴——
> 「何を聞けばいいか候補を出す」のは道具の振る舞いであって、同僚の振る舞いではない。Russell が置いているのは
> 「**個体がワークスペースにいて、同僚のように働く**」（[`../getting-started/01-introduction.md`](../getting-started/01-introduction.md)）で、
> ここは譲らない。
>
> 付随して踏まずに済む制約: 有料プラン必須 / ワークスペースゲストが使えない /
> `agent_view` は `assistant_view` に戻せない（一方通行）。
>
> **再検討してよい条件**: 「Bob を上部ナビから呼べる存在にしたい」という product 側の意図が出たとき。
> その場合も P1 以降の単位として、上の思想と突き合わせた上で決める。
>
> なお、この面が持つ**ストリーミング／thinking 状態の可視化**は思想と衝突しない（むしろ
> 「失敗が無反応として現れる」問題に効く）。採るならこれだけ `react?()` と同じ形で足せばよく、
> agent 面ごと採用する理由にはならない。

## 代替 surface（CLI / Web）

同じ `SurfaceDefinition` 契約なので差し替え可能。

- **`surface-cli`** — テストとローカル開発の主役。**外部依存なしにコアと認知ループを検証**できる（plugin-first の主要動機の1つ）
- **`surface-web`** — 本棚 `/shelf`・装備一覧 `/equipment` の読み取り専用 UI（§9.4・§10.1）や Web チャット
- 将来: Discord / 音声など。コアのコード変更なしに配列へ足すだけ

複数 surface が同時に register されうる。送信の競合は `priority` で勝者を決める（既定 0）。

## セキュリティ: trust_label = untrusted

> [!IMPORTANT]
> `InboundMessage` は既定で `trust_label: "untrusted"` を付与する（外部由来テキスト。設計書 §6.1/§12-3）。
> どの surface からの受信でも同じ — メッセージ内の指示（「〜を実行して」）は気づきトリガーとして無視し、
> 必ず mention 経由の依頼として扱う。間接プロンプトインジェクション対策。

untrusted 変数が特権ツール引数に入るとブロックする信頼ラベル伝播は Policy Gate 側の責務
（[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)）。surface は「これは外部由来だ」とラベルを付けるところまでを担う。

## 関連

- `SurfaceRegistry` の型：[`../reference/30-russell-plugin-contract.md`](../reference/30-russell-plugin-contract.md)
- Policy Gate と HITL：[`15-policy-gate-and-security.md`](./15-policy-gate-and-security.md)
- 気づき（受信 → Finding）：[`16-findings-and-proactivity.md`](./16-findings-and-proactivity.md)
