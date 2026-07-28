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
      const rl = createInterface({ input: process.stdin, terminal: false });

      const unregister = ctx.surfaces.register({
        id: "cli",
        start(sink) {
          process.stdout.write(`${name} を起動しました。話しかけてください（Ctrl-D で終了）。\n> `);
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
        rl.close();
      };
    },
  };
}
