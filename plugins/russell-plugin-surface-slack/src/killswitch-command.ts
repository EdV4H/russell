/**
 * `/russell` コマンドの実行（Slack 非依存）。設計書 §12-4、運用は kill-switch.md。
 *
 * 権限の非対称:
 * - **発動（stop）は誰でもできる。** 「発動に承認は要らない・迷ったら発動する」（kill-switch.md）。
 *   誤発動のコストより暴走のコストが高い、という運用判断をそのままコードにしている。
 * - **解除（start）は権限者だけ。** 「解除は発動より慎重に」。権限者は env
 *   `RUSSELL_KILL_OPERATORS`（Slack user id のカンマ区切り）で持つ。**未設定なら誰も解除できない**
 *   （fail-closed。設定漏れが「誰でも解除できる」に倒れてはいけない）。
 */

import type { KillSwitchCapability, StopState } from "@edv4h/russell-shared";
import { type RussellCommand, parseRussellCommand } from "./command.js";

export interface KillSwitchCommandDeps {
  /** 通常経路の実体。未設定（オフライン構成）ならその旨を返す。 */
  capability?: KillSwitchCapability;
  selfAgentId: string;
  isOperator(userId: string): boolean;
}

export interface CommandResult {
  /** 実行者へ返す文（ephemeral）。 */
  reply: string;
  /** 管理チャンネルへ流す記録（kill-switch.md「発動後の連絡フロー」）。無ければ流さない。 */
  announce?: string;
}

function describe(state: StopState): string {
  if (!state.stopped) return "現在: 稼働中（凍結なし）";
  const scope = state.scope === "all" ? "全個体" : "この個体";
  const reason = state.reason ? ` / 理由: ${state.reason}` : "";
  return `現在: 凍結中（${scope}） / 発動者: <@${state.by}> / 発動: ${state.at}${reason}`;
}

export async function runRussellCommand(
  text: string,
  userId: string,
  deps: KillSwitchCommandDeps,
): Promise<CommandResult> {
  const cmd: RussellCommand = parseRussellCommand(text, deps.selfAgentId);
  if (cmd.kind === "help") return { reply: cmd.message };

  const cap = deps.capability;
  if (!cap) {
    // レベル1/2 が無い構成。別経路（レベル3）は生きているので、そちらを案内する。
    return {
      reply:
        "この個体はキルスイッチの通常経路（DB）を持っていません。別経路（env `RUSSELL_KILL=1` で再起動）で止めてください。",
    };
  }

  if (cmd.kind === "status") {
    return { reply: describe(await cap.current(deps.selfAgentId)) };
  }

  if (cmd.kind === "stop") {
    const state = await cap.stop({
      agentId: cmd.agentId,
      scope: cmd.scope,
      by: userId,
      reason: cmd.reason,
    });
    const target = cmd.scope === "all" ? "全個体" : cmd.agentId;
    return {
      reply: `凍結しました（${target}）。自発行動は止まり、mention には停止中とだけ返します。解除は権限者の \`/russell start\` です。`,
      announce: `:octagonal_sign: キルスイッチ発動: ${target} / 発動者: <@${userId}> / ${state.at}${
        cmd.reason ? ` / 理由: ${cmd.reason}` : ""
      }`,
    };
  }

  // start（解除）
  if (!deps.isOperator(userId)) {
    return {
      reply:
        "解除は権限者のみです（`RUSSELL_KILL_OPERATORS`）。オーナーの承認を得て、権限者から実行してください。",
    };
  }
  await cap.resume({ agentId: cmd.agentId, scope: cmd.scope, by: userId });
  const target = cmd.scope === "all" ? "全個体" : cmd.agentId;
  return {
    reply: `解除しました（${target}）。しばらくは dryrun で様子を見てください（§6.5）。`,
    announce: `:white_check_mark: キルスイッチ解除: ${target} / 解除者: <@${userId}>`,
  };
}

/** env `RUSSELL_KILL_OPERATORS` から権限者判定を作る。未設定なら誰も解除できない。 */
export function operatorCheckFromEnv(
  raw = process.env.RUSSELL_KILL_OPERATORS,
): (id: string) => boolean {
  const ids = new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (id: string) => ids.has(id);
}
