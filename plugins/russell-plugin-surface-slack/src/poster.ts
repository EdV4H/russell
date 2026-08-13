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
 * **受信はしない。** `bolt.App` ではなく `WebClient` を使う——`App` は受信の器なので、
 * 投稿しかしないのに `signingSecret` を要求される（実際それで投稿が失敗した）。
 */

import type { DeliveryResult } from "@edv4h/russell-shared";
import { WebClient } from "@slack/web-api";
import { toSlackMrkdwn } from "./mrkdwn.js";

export interface SlackPosterOptions {
  botToken?: string;
}

export interface SlackPoster {
  post(channel: string, text: string): Promise<DeliveryResult>;
}

export function createSlackPoster(options: SlackPosterOptions = {}): SlackPoster {
  const token = options.botToken ?? process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("slack-poster: SLACK_BOT_TOKEN がありません");
  const client = new WebClient(token);

  return {
    async post(channel: string, text: string): Promise<DeliveryResult> {
      try {
        // 日報も同じ書式で出す（面が同じなら見え方も同じであるべき）
        await client.chat.postMessage({ channel, text: toSlackMrkdwn(text) });
        return { status: "succeeded" };
      } catch (err) {
        // タイムアウト等は unknown（blind retry しない, §9.2）。二重投稿の方が害が大きい
        return { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
