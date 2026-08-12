/**
 * Slack へ投稿するだけの口（Socket Mode を張らない）。
 *
 * 夜間バッチ（worker）が日報を投稿するために要る。worker は認知ループを持たないので
 * surface として register するわけにはいかないが、**Slack の知識を worker 側に写したくない**
 * ——それをやると「どう投稿するか」がリポジトリの2箇所に散る。
 *
 * `createSlackSurfacePlugin` と同じパッケージに置いてあるのはそのためで、
 * トークンの読み方・投稿の作法はここに一本化される。
 *
 * **受信はしない。** `app.start()` を呼ばないので Socket Mode の接続は張られない
 * （バッチが常駐イベントを掴んだままになるのを避ける）。
 */

import type { DeliveryResult } from "@edv4h/russell-shared";
import bolt from "@slack/bolt";

export interface SlackPosterOptions {
  botToken?: string;
}

export interface SlackPoster {
  post(channel: string, text: string): Promise<DeliveryResult>;
}

export function createSlackPoster(options: SlackPosterOptions = {}): SlackPoster {
  const token = options.botToken ?? process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("slack-poster: SLACK_BOT_TOKEN がありません");
  // receiver を渡さないので待ち受けは起きない。client だけを使う
  const app = new bolt.App({ token });

  return {
    async post(channel: string, text: string): Promise<DeliveryResult> {
      try {
        await app.client.chat.postMessage({ channel, text });
        return { status: "succeeded" };
      } catch (err) {
        // タイムアウト等は unknown（blind retry しない, §9.2）。二重投稿の方が害が大きい
        return { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
