/**
 * 通信面プラグイン: CLI（stdin/stdout）。
 * 標準入力の各行を「mention」として受信し、応答を標準出力へ返す。
 * 外部依存が無いので、Slack トークンや API キー無しに認知ループを検証できる。
 *
 * 送受信の責務のみ。個体名は表示に使うだけ（config から受ける）。
 */

import { createInterface } from "node:readline";
import type {
  AgentContext,
  DeliveryResult,
  OutboundMessage,
  RussellPlugin,
} from "@edv4h/russell-shared";

export interface CliSurfaceOptions {
  /** プロンプト表示に使う個体名。 */
  displayName?: string;
}

export function createCliSurfacePlugin(options: CliSurfaceOptions = {}): RussellPlugin {
  const name = options.displayName ?? "Bob";
  return {
    id: "russell-plugin-surface-cli",
    name: "CLI Surface",
    setup(ctx: AgentContext) {
      // readline を作るのは `start` の中。**`setup` で作ると入力を取りこぼす**——
      // createInterface は即座に stdin を読み始めるので、他プラグインの setup（DB 接続で
      // 数秒かかる）を待つ間に届いた行が、行ハンドラを付ける前に流れて消える。
      // 対話では気づかないが、`echo "..." | pnpm dev` のようなパイプでは最初の行が落ちる。
      let rl: ReturnType<typeof createInterface> | undefined;

      const unregister = ctx.surfaces.register({
        id: "cli",
        start(sink) {
          process.stdout.write(`${name} を起動しました。話しかけてください（Ctrl-D で終了）。\n> `);
          rl = createInterface({ input: process.stdin, terminal: false });
          rl.on("line", (line) => {
            const text = line.trim();
            if (!text) {
              process.stdout.write("> ");
              return;
            }
            // CLI 入力は操作者本人＝trusted。全行を mention として扱う。
            sink({
              surfaceId: "cli",
              contextId: "cli",
              author: "you",
              text,
              trustLabel: "trusted",
              isMention: true,
            });
          });
          rl.on("close", () => {
            ctx.events.emit("surface:cli:closed", null);
          });
        },
        async send(out: OutboundMessage): Promise<DeliveryResult> {
          process.stdout.write(`\n${name}> ${out.text}\n> `);
          return { status: "succeeded" };
        },
      });

      return () => {
        unregister();
        rl?.close(); // start されないまま teardown される経路（他プラグインの setup 失敗）がある
      };
    },
  };
}
