# リファレンス: モデル経路（echo / claude-code / claude）

会話に使うモデルはプラグイン。コアは `ModelProvider`（`complete(req) → {text}`）しか知らないので、
配列の1要素を差し替えるだけで経路が変わる。

| provider | いつ使うか | 認証 | 実測レイテンシ |
|---|---|---|---|
| `echo` | オフラインで認知ループを回す。決定論的ダミー | 不要 | 即時 |
| `claude-code` | **開発用。** 手元の Claude Code CLI を headless で呼ぶ | 手元の Claude Code のログイン | 1ターン **8秒前後**（sonnet） |
| `claude` | 本番。Claude API | `ANTHROPIC_API_KEY` | — |

選択は `apps/agent/src/main.ts`。`ANTHROPIC_API_KEY` があれば `claude`、無ければ既定は `echo`。
`claude-code` は**明示的な opt-in のときだけ**（勝手に CLI プロセスを起動しない）:

```bash
RUSSELL_MODEL=claude-code pnpm --filter @edv4h/russell-agent dev
```

## `claude-code` が開発用に限られる理由

**遅い。** 1ターン8秒前後で、P0-1 の受け入れ基準（応答レイテンシ p95 ≤ 8s）を単体で使い切る。
記憶の読み出しも DB 往復も乗る前の数字なので、**この経路で P0 バーは測れない**。

**個体を常駐させる形ではない。** 自分の手元で自分が試す分には普通の利用だが、
ワークスペースに常駐するサービスを個人のサブスクリプションで回すのは想定された使い方ではない。

`NODE_ENV=production` では setup が throw する（`autoMigrate` と同じく、規約ではなくコードで担保）。

## 隔離（ここが本題）

Claude Code は既定で**操作者の skills / MCP / ローカルツール**（Slack・メール・Drive・ブラウザ・bash…）
を引き継ぐ。そこへ Russell は **untrusted な Slack 発言をそのまま渡す**。素で繋ぐと:

- 他人の発言が「操作者の全権限を持つエージェント」へのプロンプトインジェクションになる（§12-3）
- その副作用はコアの **Policy Gate の外側**で起きる。`decide()` も監査も通らない

実際、`--allowed-tools ""` だけでは隔離できず、テスト中に Bob が Google Calendar を見に行った。
効いた組み合わせはこれ:

```
--safe-mode           # CLAUDE.md / skills / plugins / hooks / MCP / custom commands を全部無効化
--strict-mcp-config   # --mcp-config 以外の MCP を読まない（何も渡さない＝MCP 無し）
--disallowed-tools "Bash Read Write Edit …"   # 二重に塞ぐ
--system-prompt       # 既定のシステムプロンプトを「置き換える」（append ではない）
```

- **フラグはオプションで緩められない。** 緩める口を作ると「dev で緩めたまま本番へ」の経路ができる
- **`--bare` は使えない。** 隔離としては本命だが、認証が `ANTHROPIC_API_KEY` 固定になり
  （OAuth を読まない）、この経路を選ぶ理由そのものと両立しない
- プロンプトは **stdin**、システムプロンプトは **argv の1要素**（シェルを経由しない）。
  想起した記憶には他人の発言が入りうるため
- 作業ディレクトリはリポジトリの外（`os.tmpdir()`）

## 隔離が破れたら止まる

隔離は CLI 側の実装に依存していて、更新や設定で崩れうる。崩れたときに黙って
「ツールを持ったエージェントが Slack に返事をする」状態になるより、その場で止める（fail-closed）。

`--output-format json` の応答を見て、次のいずれかがあれば throw する:

| signal | 意味 |
|---|---|
| `num_turns > 1` | 途中でツールが実行された |
| `permission_denials` が空でない | ツールを使おうとした（拒否されたが試みはあった） |
| `usage.server_tool_use.*` > 0 | web 検索/取得が実際に走った |

検証は `apps/agent/test/model-claude-code.test.ts`（CLI もキーも要らない）。

関連：[`33-package-layout.md`](./33-package-layout.md), [`30-russell-plugin-contract.md`](./30-russell-plugin-contract.md)
