/**
 * 人に承認を求める（HITL, §12-2 / #12）。
 *
 * コアは「**人に聞く**」までしか決めない。**誰が押してよいか**は Slack の話なので、ここが持つ。
 *
 * > [!IMPORTANT]
 * > **押せる人を絞る。** 誰でも押せると、チャンネルに居る誰かが Bob の外部書き込みを
 * > 通せてしまう。押してよいのは**依頼した本人**か**運用者**（キルスイッチと同じ名簿）。
 * > 押した人は監査に残る。
 *
 * 期限が来たら**却下として扱う**（fail-closed）。答えが返らないときに通してしまう方が悪い。
 */

import type { ApprovalOutcome, ApprovalRequest } from "@edv4h/russell-shared";
import type { KnownBlock } from "@slack/web-api";

/** 押せるかどうか。**依頼者本人か運用者だけ**。 */
export function mayApprove(
  userId: string,
  req: Pick<ApprovalRequest, "requestedBy">,
  isOperator: (id: string) => boolean,
): boolean {
  if (isOperator(userId)) return true;
  return Boolean(req.requestedBy) && req.requestedBy === userId;
}

/** 効果分類を、押す人に分かる言葉にする。 */
const EFFECT_LABEL: Record<string, string> = {
  external_write: "外部への書き込み",
  external_send: "外部への送信",
  irreversible_write: "取り消せない変更",
};

/**
 * 承認を求める投稿の中身（Block Kit）。
 *
 * **何をするのか・どこへ出るのか・中身は何かを、押す前に見せる。**
 * 「承認しますか？」だけのボタンは、押す人を判断できないまま押させることになる。
 */
export function approvalBlocks(req: ApprovalRequest, nonce: string): KnownBlock[] {
  const effect = EFFECT_LABEL[req.effect] ?? req.effect;
  const preview = (req.previewText ?? "").slice(0, 2500);
  const until = new Date(req.expiresAt);
  const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*承認をお願いします*\n${req.summary}` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${effect} ・ \`${req.tool}\` ・ ${hhmm} までに押されなければ*実行しません*`,
        },
      ],
    },
  ];
  if (preview) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `\`\`\`\n${preview}\n\`\`\`` } });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "承認" },
        action_id: "russell_approve",
        value: nonce,
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: "却下" },
        action_id: "russell_reject",
        value: nonce,
      },
    ],
  });
  return blocks;
}

/** 決まった後に残す文。**誰がどうしたかを、その場に残す**（後から見て分かるように）。 */
export function decidedText(req: ApprovalRequest, outcome: ApprovalOutcome): string {
  if (outcome.reason === "expired") {
    return `⏱️ 期限切れのため実行しませんでした — ${req.summary}`;
  }
  const who = outcome.by ? `<@${outcome.by}>` : "誰か";
  return outcome.approved
    ? `✅ ${who} が承認しました — ${req.summary}`
    : `🚫 ${who} が却下しました — ${req.summary}`;
}

/**
 * 待っている承認の置き場。
 *
 * **プロセス内にしか持たない。** 再起動すれば消える——そのときは「承認されなかった」に
 * なるだけで、危ない側へは倒れない。
 */
export function createApprovalDesk() {
  const waiting = new Map<
    string,
    {
      req: ApprovalRequest;
      settle: (o: ApprovalOutcome) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  let seq = 0;

  return {
    /** 承認を待ち始める。`nonce` はボタンに載せる引換券。 */
    open(req: ApprovalRequest, onExpire: (nonce: string, req: ApprovalRequest) => void) {
      seq += 1;
      const nonce = `ap-${seq}-${req.tool}`;
      const promise = new Promise<ApprovalOutcome>((resolve) => {
        const ms = Math.max(0, new Date(req.expiresAt).getTime() - Date.now());
        const timer = setTimeout(() => {
          waiting.delete(nonce);
          onExpire(nonce, req);
          // **期限＝却下**。返らない答えを待って通すことはしない
          resolve({ approved: false, reason: "expired" });
        }, ms);
        timer.unref?.();
        waiting.set(nonce, { req, settle: resolve, timer });
      });
      return { nonce, promise };
    },

    /** 待っている中身を見る（押せる人かを確かめるため。まだ閉じない）。 */
    peek(nonce: string): ApprovalRequest | undefined {
      return waiting.get(nonce)?.req;
    },

    /** ボタンが押された。知らない引換券（再起動後など）なら `undefined`。 */
    close(nonce: string, outcome: ApprovalOutcome): ApprovalRequest | undefined {
      const hit = waiting.get(nonce);
      if (!hit) return undefined;
      if (hit.timer) clearTimeout(hit.timer);
      waiting.delete(nonce);
      hit.settle(outcome);
      return hit.req;
    },

    get size(): number {
      return waiting.size;
    },
  };
}
