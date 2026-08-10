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
- **自然言語コマンド** — 「覚えておいて」「忘れて」を解釈して記憶操作へ（→ `shelf.add` / strength 操作。
  [`12-memory-system.md`](./12-memory-system.md)）

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
| allowlist に無いチャンネル | opt-in していない場所を読まない |
| スレッド外の発言 | チャンネルの雑談を拾い始めると「全部読んでいる」になる |
| Bob がまだ発言していないスレッド | 呼ばれてもいない会話に入っていかない |
| mention を含む発言 | `app_mention` でも届く。両方処理すると2回返信する |
| bot 自身の発言 / `subtype` 付き | 自分に返事を続けない |

> [!IMPORTANT]
> **決定（2026-08-10）: 追従は「参加スレッドのみ」＋チャンネル allowlist。全読みはしない。**
> privacy-and-memory-policy の「明示的に招待され、かつ台帳登録されたチャンネルのみ購読・記憶。
> **勝手読みは既定禁止**」を満たす形にした。allowlist は当面 env `RUSSELL_SLACK_CHANNELS`
> （カンマ区切り）で、**空なら追従しない** — 設定漏れが「全部読む」に倒れてはいけない。
> 将来 `channel_settings` 台帳へ移す。
>
> 発注書の「`message.channels` 全読みは P0 不要」は**全読み**を外したもので、この形は
> それに反しない。気づきモジュール（§6.2, P3）が全発言を必要とするときに、改めて
> 台帳とレートリミッタとセットで判断する。

「Bob が発言したスレッド」は surface プラグインが `send()` を見て覚える。**プロセス内にしか
持たないので再起動すると忘れる**（そのスレッドで一度 mention すれば戻る）。DB に置けば残せるが
テーブルが1つ増えるので、P0 の範囲では持たない。

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
