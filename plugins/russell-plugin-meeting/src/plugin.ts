/**
 * 会議に参加する装備。
 *
 * **参加は外へ出る行為である。** 参加者一覧に Bob の名前が出て、その場にいる全員に見える。
 * だから `external_send` として扱い、**実行の前に人の承認**が要る（#113）。
 *
 * > [!IMPORTANT]
 * > **抜けるのは妨げない。** `meeting.leave` は承認を要らない扱いにしてある——
 * > 止める方向の行為に承認を挟むと、「出たいのに出られない」が起きる。
 * > キルスイッチと同じ考え方（止めるのは常に通す, §12-4）。
 *
 * **文字起こしは、取っただけでは記憶に入らない。** 受け取った発言はプロセス内に溜まり、
 * `meeting.transcript` で明示的に取り出したときだけ会話へ出る。何をどこまで残すかは
 * まだ決めていないので、**既定では溢れない**形にしてある。
 */

import type { AgentContext, RussellPlugin, SourceResult } from "@edv4h/russell-shared";
import type { MeetingProvider, MeetingSession, TranscriptLine } from "./types.js";

export interface MeetingOptions {
  /** どうやって参加するか。**未指定なら装備そのものを支給しない**（§9.2）。 */
  provider?: MeetingProvider;
  /** 溜めておく発言の上限。長い会議で際限なく持たないため。 */
  maxLines?: number;
}

/** 溜めておく上限。超えた分は**古い方から捨てる**（終盤の話の方が要約に効く）。 */
const DEFAULT_MAX_LINES = 2000;

interface Joined {
  session: MeetingSession;
  title?: string;
  joinedAt: number;
  lines: TranscriptLine[];
  dropped: number;
}

export function createMeetingPlugin(options: MeetingOptions = {}): RussellPlugin {
  return {
    id: "meeting",
    name: "会議",
    setup(ctx: AgentContext) {
      const provider = options.provider;
      // **経路が無ければ何も register しない。** 持っていない能力の存在を知らせない（§9.2）
      if (!provider) {
        console.warn("[meeting] 参加の経路がありません。この装備は支給されません。");
        return;
      }
      const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
      /** いま入っている会議。**同時に1つだけ**——2つの会議を同時に聞いても混ざるだけ。 */
      let current: Joined | undefined;

      ctx.policy.declareEffect("meeting.join", "external_send");
      // 抜けるのは止める方向の行為なので、承認を挟まない（上記）
      ctx.policy.declareEffect("meeting.leave", "internal_write");
      ctx.policy.declareEffect("meeting.transcript", "read");

      const offEquipment = ctx.equipment.register({
        id: "meeting",
        mcpServer: {},
        scopes: ["meeting:join"],
        // external_send から導出（2以上は毎回 HITL, guides/22）
        dangerLevel: 2,
        tools: () => [
          { name: "meeting.join", effect: "external_send" },
          { name: "meeting.leave", effect: "internal_write" },
          { name: "meeting.transcript", effect: "read" },
        ],
      });

      const offJoin = ctx.tools.register("meeting.join", {
        name: "meeting.join",
        effect: "external_send",
        async describe(input: { url?: string; title?: string }) {
          const where = (input?.title ?? "").trim() || (input?.url ?? "").trim();
          return {
            summary: `会議〈${where}〉に入ります（参加者一覧に出ます）`,
            // **押す前に、どこへ入るかを見せる。** URL は書き換えられていないか確かめる材料になる
            preview: (input?.url ?? "").trim(),
          };
        },
        async run(input: { url: string; title?: string }): Promise<SourceResult<{ id: string }>> {
          const url = (input?.url ?? "").trim();
          if (url === "") return { status: "failed", freshness: new Date().toISOString() };
          if (current) {
            // **黙って乗り換えない。** 前の会議に入ったままだと思っている人がいる
            return { status: "failed", freshness: new Date().toISOString() };
          }
          try {
            const session = await provider.join({ url, title: input?.title });
            const joined: Joined = {
              session,
              title: input?.title,
              joinedAt: Date.now(),
              lines: [],
              dropped: 0,
            };
            session.onLine((line) => {
              joined.lines.push(line);
              // 古い方から捨てる。**捨てたことは数える**（黙って欠けさせない）
              if (joined.lines.length > maxLines) {
                joined.lines.shift();
                joined.dropped++;
              }
              ctx.events.emit("meeting:line", { meeting: session.id, speaker: line.speaker });
            });
            current = joined;
            ctx.events.emit("meeting:joined", { meeting: session.id, via: provider.id });
            return {
              status: "complete",
              freshness: new Date().toISOString(),
              data: { id: session.id },
            };
          } catch {
            return { status: "failed", freshness: new Date().toISOString() };
          }
        },
      });

      const offLeave = ctx.tools.register("meeting.leave", {
        name: "meeting.leave",
        effect: "internal_write",
        async run(): Promise<SourceResult<{ lines: number; minutes: number; dropped: number }>> {
          if (!current) return { status: "failed", freshness: new Date().toISOString() };
          const joined = current;
          current = undefined;
          // **出られなくても、こちらは出たことにする。** 掴んだままにする方が困る
          await joined.session.leave().catch(() => {});
          ctx.events.emit("meeting:left", {
            meeting: joined.session.id,
            lines: joined.lines.length,
          });
          // 記録は残す（次に transcript で取り出せる）。**出た時点では会話へ出さない**
          last = joined;
          return {
            status: "complete",
            freshness: new Date().toISOString(),
            data: {
              lines: joined.lines.length,
              minutes: Math.round((Date.now() - joined.joinedAt) / 60_000),
              dropped: joined.dropped,
            },
          };
        },
      });

      /** 直前に出た会議。**取り出すのは明示的な操作**にしてある。 */
      let last: Joined | undefined;

      const offTranscript = ctx.tools.register("meeting.transcript", {
        name: "meeting.transcript",
        effect: "read",
        async run(): Promise<
          SourceResult<{ text: string; lines: number }> & { trustLabel: string }
        > {
          const target = current ?? last;
          const now = new Date().toISOString();
          if (!target) {
            return { status: "failed", freshness: now, trustLabel: "untrusted" };
          }
          const text = target.lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
          return {
            // 捨てた分があるなら**全部は見ていない**（complete と名乗らない, §6.3）
            status: target.dropped > 0 ? "partial" : "complete",
            freshness: now,
            data: { text, lines: target.lines.length },
            // 他人の発言なので untrusted。**来歴を消さない**（§12-3）
            trustLabel: "untrusted",
          };
        },
      });

      return () => {
        offTranscript();
        offLeave();
        offJoin();
        offEquipment();
      };
    },
  };
}
