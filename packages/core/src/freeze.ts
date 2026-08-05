/**
 * キルスイッチの判定（§12-4 / §12-7）。運用は docs/preparation/operations/kill-switch.md。
 *
 * 段階は3つ。**強い方が勝つ**:
 * - `silent`  … env `RUSSELL_KILL=1`（レベル3・別経路）。完全沈黙。DB を一切見ないので DB 障害時にも効く
 * - `stopped` … `/russell stop`（レベル1/2・通常経路）。自発行動を凍結し、mention には
 *               「いま止まっています」だけ返す（状況を説明できる方が親切、という決定 2026-07-23）
 * - `none`    … 通常運転
 *
 * **読めないときは `silent` に倒す。** §12-7 は「ポリシー情報・承認記録・キルスイッチが DB で
 * 読めないときは、外部送信・書き込みを行わない側に倒す」と定めている。停止中かどうか分からない
 * まま「止まっています」を投稿するのも外部送信なので、ここでは黙る方を選ぶ。
 *
 * キャッシュは持たない。§5.1 が「副作用の直前にモードとキルスイッチを再検査」を要求しており、
 * 数百 ms 古い値で1回投稿してしまう方が、DB を1回読む費用より高くつく。
 */

import type {
  EventBus,
  FreezeLevel,
  KillSwitchCapability,
  ServiceRegistry,
} from "@edv4h/russell-shared";
import { KILL_SWITCH_SERVICE } from "@edv4h/russell-shared";

export type FreezeGate = () => Promise<FreezeLevel>;

export function createFreezeGate(
  agentId: string,
  services: ServiceRegistry,
  events: EventBus,
): FreezeGate {
  // 「読めない」状態の出入りだけを通知する（毎ターン同じエラーを出し続けない）。
  let unreadable = false;

  return async function freezeLevel(): Promise<FreezeLevel> {
    // 別経路が最優先。ここで DB を見ないことが「DB 障害時にも効く」の実体（§12-7）。
    if (process.env.RUSSELL_KILL === "1") return "silent";

    const cap = services.get<KillSwitchCapability>(KILL_SWITCH_SERVICE);
    // 通常経路を持たない構成（オフライン stack 等）。env だけが効く。
    if (!cap) return "none";

    try {
      const state = await cap.current(agentId);
      if (unreadable) {
        unreadable = false;
        events.emit("killswitch:recovered", {});
      }
      return state.stopped ? "stopped" : "none";
    } catch (err) {
      if (!unreadable) {
        unreadable = true;
        events.emit("killswitch:unreadable", { error: String(err) });
        // 監査も落ちている可能性があるので、プロセスログには必ず出す。
        console.error(
          "[killswitch] 凍結状態を読めません。完全沈黙へ倒します（fail-closed）。",
          err,
        );
      }
      return "silent";
    }
  };
}
