# 装備台帳 初期リスト

> [!NOTE]
> 準備物 B-1。設計書 [`../../design/human-like-agent-design.md`](../../design/human-like-agent-design.md) §9（Equipment）が源泉。
> plugin-first（[`../../design/plugin-first-reinterpretation.md`](../../design/plugin-first-reinterpretation.md)）では装備＝`equipment-*` プラグイン（`russell-plugin-equipment-{name}`）で、`equipment` レジストリに register する。台帳は §9.1 の `equipment` / `issuances` テーブルの初期投入データにあたる。

## 装備の実装単位（§9.1）

装備1つ = **MCPサーバー1接続 + 権限スコープ + 危険度** のパッケージ。新装備の追加は台帳へ登録するだけで本体コード変更不要（MCP の疎結合思想）。

- 未支給の装備は**ツール定義自体をコンテキストに載せない**（§9.2 Prompt Guardrail Fallacy 回避）。
- Policy Gate の allowlist は `issuances` から機械生成。支給/回収が即、実行境界に反映。
- `danger_level` は効果分類から導出。**2以上は使用のたび HITL 承認**。
- 全 write 系は実行前 preflight、結果不明（`OperationResult=unknown`）の blind retry 禁止（§9.2）。

## 台帳サマリ

| equipment id | MCPサーバー | 主なスコープ | danger_level | 効果分類 | 支給先プリセット |
|---|---|---|---|---|---|
| `slack` | surface 兼装備（[`presets.md`](./presets.md) 参照） | `chat:write` / `reactions:write` / `*:history` | 1 | `external_send` | 全プリセット |
| `github.issues` | GitHub MCP（自リポ限定） | issues:write（**Russell 自身のリポのみ**） | 2 | `external_write` | 編集者・石橋（+ 全個体のセルフイシュー §6.4） |
| `notion` | Notion MCP | read / write（別スコープ） | 2 | `external_write` | 編集者 |
| `terminal` | サンドボックス shell MCP | コマンド実行（**サンドボックスVM限定**） | 3 | `irreversible_write` | 初期は誰にも支給しない |

> danger_level 0=read のみ / 1=external_send / 2=毎回 HITL（external_write）/ 3=最危険（サンドボックス限定・破壊系 HITL 必須）。

---

## slack

Slack 通信面。§10 は plugin-first では `surface-slack` プラグイン扱いだが、送信・リアクションという「外部への働きかけ」の側面は装備として Policy Gate を通る。

```json
{
  "id": "slack",
  "mcp_server": "<TODO>",
  "scopes": ["app_mentions:read", "channels:history", "im:history", "chat:write", "reactions:write"],
  "danger_level": 1,
  "tools": [
    { "name": "slack.post", "effect": "external_send" },
    { "name": "slack.react", "effect": "external_send" },
    { "name": "slack.read", "effect": "read" }
  ]
}
```

- スコープは §10 の最小権限リストと一致。
- 投稿は §6 の `daily_speak_cap` + 静音時間 + §12-8 outbound 多層上限で制御。

> [!TODO] slack MCP サーバーの選定 — 承認者: 実装担当 + リポ管理者。候補: (a) Bolt/Socket Mode を自前で `surface-slack` に内蔵（設計書 §10・§11 推奨、Socket Mode で inbound 開放不要）、(b) 既存 Slack MCP サーバーを装備として接続。**受信購読（app_mention 等）は surface としての責務、送信は装備としての責務**という二面性の整理も同時に確定する。

## github.issues

セルフイシュー（§6.4）と編集者の doc PR/Issue に使う。**Russell 自身のリポジトリのみに限定支給。**

```json
{
  "id": "github.issues",
  "mcp_server": "<TODO>",
  "scopes": ["issues:write@self-repo-only", "issues:read@self-repo-only"],
  "danger_level": 2,
  "tools": [
    { "name": "github.issue.create", "effect": "external_write" },
    { "name": "github.issue.comment", "effect": "external_write" },
    { "name": "github.issue.read", "effect": "read" }
  ]
}
```

- **対象リポは Russell 本体のセルフイシュー起票先に限定**（§6.4）。他リポへの起票はスコープ外で default deny。
- 自動起票はスコープ付き事前承認（対象リポ × 週あたり件数上限、例 3件/週、§6.4・§12-2）の範囲でのみ。再発は新規起票せず既存 Issue にコメント追記。
- untrusted 由来テキスト（Slack 発言）を根拠にした自動起票は禁止。user_feedback は本人確認 HITL 経路のみ（[`finding-dictionary.md`](./finding-dictionary.md)）。

> [!TODO] github.issues MCP サーバーの選定と、起票先リポジトリの確定 — 承認者: リポ管理者。候補: GitHub 公式 MCP / `gh` CLI ラッパ。self-repo-only のスコープをトークン側（Fine-grained PAT の repo 限定）でも二重に強制するか決める。件数上限は [`finding-dictionary.md`](./finding-dictionary.md) と一致させる。

## notion

編集者のドキュメント更新（§8.2）。read と write を**別スコープ**に分ける（§9.1）。

```json
{
  "id": "notion",
  "mcp_server": "<TODO>",
  "scopes": ["notion.read", "notion.write@granted-pages-only"],
  "danger_level": 2,
  "tools": [
    { "name": "notion.page.read", "effect": "read" },
    { "name": "notion.page.update", "effect": "external_write" },
    { "name": "notion.page.create", "effect": "external_write" }
  ]
}
```

- write は編集者にのみ支給。対象ページ/データベースを granted 範囲に限定（doc_drift の反映先、[`finding-dictionary.md`](./finding-dictionary.md)）。
- 編集者の Notion 更新は「ルーティンを live 公開する承認をもって、その config_version・その棚の範囲で事前承認済み」（§12-2 の例）。

> [!TODO] notion MCP サーバーの選定と、書き込み許可するワークスペース/ページ範囲の確定 — 承認者: プロダクトオーナー + Notion ワークスペース管理者。候補: Notion 公式 MCP。read だけ先に支給し write は P3 以降に段階解禁する案も検討。

## terminal

最危険装備（§9.2, danger_level 3）。**初期は誰にも支給しない**（台帳には登録だけしておく）。

```json
{
  "id": "terminal",
  "mcp_server": "<TODO>",
  "scopes": ["shell.exec@sandbox-vm-only"],
  "danger_level": 3,
  "tools": [
    { "name": "terminal.exec", "effect": "irreversible_write" }
  ]
}
```

- **サンドボックスVM限定。全コマンドを `event_log` へ記録。破壊系コマンドは HITL 必須**（§9.2）。
- 支給/回収イベントは監査ログと日報の両方に載る（「覚さんに terminal が支給されました」§9.2）。
- 初期ラインナップ（[`presets.md`](./presets.md)）のどのプリセットにも支給しない。将来の運用エージェント向け。

> [!TODO] terminal のサンドボックス基盤の選定 — 承認者: プロダクトオーナー + インフラ担当。候補: 使い捨てコンテナ / Firecracker microVM / 専用サンドボックスサービス。支給は当面凍結し、必要になった時点で改めて A-1/A-3 の承認プロセスを通す。

---

## issuances 初期投入（§9.1）

`proficiency` は全個体 0.2（新人）から。習熟度が低いうちは確認質問が増え HITL 頻度が上がる（§9.3）。

```sql
-- 個体1号: 覚（スポンジ）— slack のみ
INSERT INTO issuances (agent_id, equipment_id, proficiency, granted_by) VALUES
  ('<覚のagent_id>', 'slack', 0.2, '<granted_by: オーナー>');
-- セルフイシューは全個体に github.issues を限定支給（自リポ・件数上限つき）
--   ↑ 支給するか、P3まで凍結するかは下記TODO
```

`granted_by` は §9.1 の必須列。誰が支給したかの権限は [`../operations/ownership-and-approval.md`](../operations/ownership-and-approval.md) の装備支給オーナーに紐づく。

## 可視性（§9.4）

個体プロフィール（Web UI `/equipment`・Slack プロフィール欄）に装備一覧と習熟度を表示。記憶の全公開（§10.1）と同じ透明性原則で、誰が何をできるかはチーム全員から見える。

> [!TODO] 個体1号にセルフイシュー用の `github.issues` を初期支給するか、P3（気づき）まで凍結するかの決定 — 承認者: プロダクトオーナー + リポ管理者。§13 の段階解禁では、まず slack のみで P0〜P2 を回し、Issue 自動起票は dryrun 並走を経てから live にするのが安全。

関連: [`presets.md`](./presets.md) / [`finding-dictionary.md`](./finding-dictionary.md) / [`../infra/setup-checklist.md`](../infra/setup-checklist.md)（MCP 接続情報のシークレット管理）/ [`../../reference/30-russell-plugin-contract.md`](../../reference/30-russell-plugin-contract.md)（EquipmentDefinition）
