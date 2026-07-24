/**
 * プラグインの最小テンプレート（surface の例）。
 * 出典: docs/guides/20-authoring-a-plugin.md, 21-authoring-a-surface.md。
 *
 * ポイント（usketch と同じ規約）:
 * - 契約は { id, name, setup(ctx) } のみ。種別フィールドは持たない。
 * - 「どのレジストリに register するか」で自己分類する（ここは surfaces）。
 * - 状態は setup 内のクロージャに持つ。
 * - teardown は setup の戻り値で返す（プロパティに置かない）。
 * - 公開は create*Plugin() ファクトリ（毎回新鮮なインスタンス）。
 */

import type { AgentContext, RussellPlugin } from "@edv4h/russell-shared";

export interface AcmeSurfaceOptions {
  greeting?: string;
}

export function createAcmeSurfacePlugin(options: AcmeSurfaceOptions = {}): RussellPlugin {
  return {
    id: "russell-plugin-acme-surface",
    name: "Acme Surface (example)",
    setup(ctx: AgentContext) {
      // 状態はクロージャに（プラグインオブジェクトに持たせない）
      let started = false;

      const unregister = ctx.surfaces.register({
        id: "acme",
        start(sink) {
          started = true;
          // 実際の surface はここで外部（Slack/CLI/…）を購読し、
          // 受信を InboundMessage に正規化して sink に渡す。
          // 例: sink({ surfaceId: "acme", contextId: "demo", author: "u", text: "hi",
          //           trustLabel: "untrusted", isMention: true });
          void sink;
          void options.greeting;
        },
        async send(out) {
          // 実際の surface はここで宛先へ送信する。
          void out;
          return { status: "succeeded" };
        },
      });

      // teardown: 購読解除・接続クローズなど
      return () => {
        if (started) {
          /* stop subscription */
        }
        unregister();
      };
    },
  };
}
