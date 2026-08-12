/**
 * `/russell` スラッシュコマンドの解釈（§12-4 レベル1/2）。
 *
 * Slack への接続を持たない純関数にしてある。**入力は他者が書いた文字列**なので、
 * ここでの仕事の半分は「何を受け付けないか」を決めること（§12-3）。
 *
 *   /russell stop                  … この個体を凍結
 *   /russell stop 誤送信が続いている  … 同上（残りは理由として記録）
 *   /russell stop bob              … 個体名が自分と一致するときだけ個体指定として扱う
 *   /russell stop --agent=alice    … 別個体を凍結（同じ DB を見ている個体に効く）
 *   /russell stop --all            … 全個体を凍結
 *   /russell start [--agent=x|--all]  … 解除（権限者のみ・kill-switch.md）
 *   /russell status                … 現在の凍結状態
 *
 * 曖昧さの倒し方: `stop` の後ろの語が個体名か理由か分からないときは、**理由**と解釈して
 * 「自分を止める」に倒す。`/russell stop spam` を「spam という個体を止める」と読むと、
 * 発動したつもりで何も止まっていない状態になる——キルスイッチで最も避けたい失敗。
 */

import type { StopScope } from "@edv4h/russell-shared";

/** 個体 id の形。プラグイン側（killswitch-pg）と同じ制約を入口でも掛ける。 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type RussellCommand =
  | { kind: "stop"; scope: StopScope; agentId: string; reason?: string }
  | { kind: "start"; scope: StopScope; agentId: string }
  | { kind: "status" }
  /**
   * 日報の投稿先。**打ったチャンネルだけ**が対象（任意の宛先を渡せない）。
   *
   * 個体の指定は stop/start と同じ（`--agent=<個体>` / `--all`）。Slack の
   * スラッシュコマンドは**1ワークスペースに1アプリ**しか持てないので、個体ごとに
   * 別アプリだと2体目は `/russell` を持てない。**受信した1体が他の個体の設定を書く**。
   */
  | { kind: "journal"; action: "here" | "off"; scope: StopScope; agentId: string }
  | { kind: "help"; message: string };

const USAGE =
  "使い方: `/russell stop [--all|--agent=<個体>] [理由]` / `/russell start [--all|--agent=<個体>]` / `/russell status`" +
  " / `/russell journal here|off`";

/** `--agent=x` / `--all` を取り出し、残りの語を返す。 */
function takeFlags(tokens: string[]): {
  all: boolean;
  agent?: string;
  rest: string[];
  unknown?: string;
} {
  let all = false;
  let agent: string | undefined;
  let unknown: string | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    if (!t.startsWith("--")) {
      rest.push(t);
      continue;
    }
    if (t === "--all") {
      all = true;
    } else if (t.startsWith("--agent=")) {
      agent = t.slice("--agent=".length);
    } else if (unknown === undefined) {
      unknown = t;
    }
  }
  return { all, agent, rest, unknown };
}

export function parseRussellCommand(text: string, selfAgentId: string): RussellCommand {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const verb = (tokens[0] ?? "").toLowerCase();
  const { all, agent, rest, unknown } = takeFlags(tokens.slice(1));

  if (unknown !== undefined) {
    return { kind: "help", message: `知らないオプションです: \`${unknown}\`\n${USAGE}` };
  }
  if (agent !== undefined && !AGENT_ID_PATTERN.test(agent)) {
    return { kind: "help", message: `個体名の形式が不正です: \`${agent}\`\n${USAGE}` };
  }
  if (all && agent !== undefined) {
    return { kind: "help", message: `\`--all\` と \`--agent\` は同時に使えません。\n${USAGE}` };
  }

  if (verb === "status") return { kind: "status" };

  // 日報の投稿先。**打ったチャンネルしか指定できない**——任意のチャンネル ID を渡せると、
  // Bob が居ない場所や、より広い場所へ黙って向けられる（#37 と同じ「opt-in の実体は Slack の操作」）。
  if (verb === "journal") {
    const target = (rest[0] ?? "").toLowerCase();
    const scope: StopScope = all ? "all" : "agent";
    const agentId = all ? selfAgentId : (agent ?? selfAgentId);
    if (target === "here") return { kind: "journal", action: "here", scope, agentId };
    if (target === "off") return { kind: "journal", action: "off", scope, agentId };
    return {
      kind: "help",
      message:
        "使い方: `/russell journal here`（このチャンネルに日報を出す） / `/russell journal off`",
    };
  }

  if (verb === "stop" || verb === "start") {
    const scope: StopScope = all ? "all" : "agent";
    // 先頭の語が自分の個体名なら「個体指定」として食べる（`/russell stop bob`）。
    // それ以外は理由の一部として扱う（上のコメントの倒し方）。
    const words = rest[0]?.toLowerCase() === selfAgentId.toLowerCase() ? rest.slice(1) : rest;
    const agentId = all ? selfAgentId : (agent ?? selfAgentId);
    if (verb === "start") return { kind: "start", scope, agentId };
    const reason = words.join(" ").trim();
    return { kind: "stop", scope, agentId, reason: reason || undefined };
  }

  return { kind: "help", message: USAGE };
}
