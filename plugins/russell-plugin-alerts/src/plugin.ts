/**
 * 安全側に倒れたことを、運用者へ届ける（#25）。
 *
 * コアは危ないときにイベントを出すが、**購読者が1人もいなかった**。だから外から見ると
 * 次の4つが同じ姿になる——**どれも「Bob が黙っている」**。
 *
 * - 正常に静か
 * - 監査が書けなくなって全停止（fail-closed, §12-7）
 * - 凍結状態が読めず完全沈黙
 * - プロセスが落ちた
 *
 * 黙ること自体は設計どおりで、**問題は黙ったことが誰にも届かないこと**である。
 *
 * > [!IMPORTANT]
 * > **監査が書けなくても投げる。** 通常の送信は「監査が残せないなら送らない」（§12-7）だが、
 * > ここはその監査が壊れたことを伝える経路なので、同じ規則を当てると**壊れたときだけ黙る**
 * > という最悪の性質になる。代わりに範囲を狭くしてある:
 * > **宛先は管理チャンネル固定**、**本文は定型**（何が起きたかと件数だけ）、
 * > **会話の内容は一切含まない**。キルスイッチの発動記録が同じ経路で流れるのと同じ扱い。
 */

import {
  ALERT_SERVICE,
  type AlertSink,
  type RussellPlugin,
  type RussellTeardown,
} from "@edv4h/russell-shared";

/** 既定の抑制窓。同じ種類は、これだけ黙ってからまとめて出す。 */
const DEFAULT_WINDOW_MS = 10 * 60_000;

/**
 * 購読するイベントと、運用者に見せる文。
 *
 * **「何が起きたか」より「いま何が止まっているか」を書く**——受け取った人が
 * 次に何をすべきか分かる形にする。
 */
export const ALERT_EVENTS: Record<string, string> = {
  "audit:degraded": "監査が書けなくなりました。以降のターンは止まります（fail-closed）",
  "audit:recovered": "監査が書けるようになりました。応答を再開します",
  "killswitch:unreadable": "凍結状態が読めません。完全沈黙へ倒しています",
  "killswitch:recovered": "凍結状態が読めるようになりました",
  "turn:error": "ターンが失敗しました",
  "policy:blocked": "Policy Gate が拒否しました",
  "mode:change-blocked": "モード変更を拒否しました",
};

/**
 * 同じ知らせで埋めないための抑制。
 *
 * **1件目はすぐ出す**（気づくのが遅れる方が困る）。以降は窓の間ためて、
 * 窓が明けたときに件数付きで出す。**溜めた件数を捨てない**——
 * 「10分で1件」と「10分で400件」はまったく違う話なので。
 */
export function createAlertThrottle(windowMs = DEFAULT_WINDOW_MS, now = () => Date.now()) {
  const seen = new Map<string, { until: number; held: number }>();
  return {
    /** 出してよければ件数を返す（1 なら初回、2 以上はまとめ）。黙るときは 0。 */
    admit(key: string): number {
      const at = now();
      const hit = seen.get(key);
      if (!hit || at >= hit.until) {
        const held = hit?.held ?? 0;
        seen.set(key, { until: at + windowMs, held: 0 });
        return held + 1;
      }
      hit.held += 1;
      return 0;
    },
  };
}

export interface AlertsOptions {
  /** 抑制窓（ミリ秒）。既定10分。 */
  windowMs?: number;
}

/**
 * 安全系イベントを管理チャンネルへ流す薄いプラグイン。
 *
 * 宛先（`AlertSink`）は**通信面が提供する**。無い構成（CLI・オフライン）では
 * プロセスログにだけ出す——**黙らせない**のがこのプラグインの唯一の仕事なので。
 */
export function createAlertsPlugin(options: AlertsOptions = {}): RussellPlugin {
  return {
    id: "alerts",
    name: "運用への通知",
    setup(ctx): RussellTeardown {
      const throttle = createAlertThrottle(options.windowMs);
      const offs: (() => void)[] = [];

      for (const [event, label] of Object.entries(ALERT_EVENTS)) {
        offs.push(
          ctx.events.on(event, (payload: unknown) => {
            // 同じ道具の拒否が続くときに、1行ずつ流さない
            const detail = detailOf(event, payload);
            const times = throttle.admit(`${event}:${detail}`);
            if (times === 0) return;
            const count = times > 1 ? `（${times}件）` : "";
            const text = `⚠️ ${ctx.runtime.agentId}: ${label}${detail ? ` — ${detail}` : ""}${count}`;
            // **必ずプロセスログにも出す。** 宛先が無い構成でも、痕跡は残す
            console.warn(`[alerts] ${text}`);
            // 宛先は遅延解決する（通信面より先に setup されても効くように）
            const sink = ctx.services.get<AlertSink>(ALERT_SERVICE);
            // 送信の失敗でターンを壊さない。ここは最後の砦なので、投げっぱなしにする
            void sink?.send(text).catch((err) => {
              console.error(`[alerts] 通知を送れませんでした: ${String(err)}`);
            });
          }),
        );
      }

      return () => {
        for (const off of offs) off();
      };
    },
  };
}

/**
 * 知らせに添える一言。**本文は絶対に入れない**（A1-5）。
 * 入れてよいのは道具名やエラーの種類のような、それ自体が機微でないものだけ。
 */
/** 通知に載せる理由の上限。**長い stderr をそのまま流さない**（A1-5 の観点でも切る）。 */
const MAX_DETAIL = 200;

/**
 * 知らせに添える理由。
 *
 * > [!IMPORTANT]
 * > **ターンの失敗は理由を出す。** 出していなかったので、`⚠️ ターンが失敗しました` だけが
 * > 毎回流れ、**何が起きているのか誰にも分からなかった**（実際、毎回1通目が失敗していた
 * > のに原因を追えなかった）。知らせるだけで理由を落とすなら、知らせていないのと大差ない。
 * >
 * > 載せるのは**1行目だけ**を切り詰めたもの。エラーの文言は本文ではないが、
 * > CLI の stderr がそのまま入ることがあるので、長さで頭を打つ。
 */
function detailOf(event: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (event === "policy:blocked" && typeof p.tool === "string") return p.tool;
  if (event === "mode:change-blocked" && typeof p.reason === "string") return p.reason;
  if (event === "turn:error") {
    const message = payload instanceof Error ? payload.message : String(p.message ?? "");
    return (message.split("\n")[0] ?? "").slice(0, MAX_DETAIL);
  }
  return "";
}
