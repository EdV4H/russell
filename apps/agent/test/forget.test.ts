/**
 * 「忘れて」— L1（弱める）。env 不要。
 *
 * 設計（privacy-and-memory-policy §3）の3段階のうち、いま提供するのは L1 だけ。
 * L2（物理削除）以上は HITL 承認が前提で、既定値もサインオフ待ち。
 * **できていないことをできたと言わない**のが、この機能でいちばん大事なところ。
 *
 * 忘れる判断はモデルが行う（P0-3/P0-4）。以前は正規表現で「忘れて」を拾い、固定文
 * （「書庫に下げました」）を返していた。固定文が無くなった今、この約束を持つのは
 * **人格プロンプト**なので、そこに載っていることをテストで押さえる。
 */

import { createAgent } from "@edv4h/russell-core";
import { createInMemoryMemoryPlugin } from "@edv4h/russell-plugin-memory-inmem";
import type { InboundMessage, RussellPlugin, Temperament } from "@edv4h/russell-shared";
import { expect, test } from "vitest";
import { type ScriptedModel, scriptedModel } from "./memory-model.js";

const BOB: Temperament = {
  name: "Bob",
  tone: "丁寧",
  proactivity: 0.3,
  daily_speak_cap: 3,
  curiosity: 0.9,
  reaction_rate: 0.7,
};

const NOTHING = '{"note":null,"shelf":null,"forget":null}';
const shelve = (card: string) => `{"note":null,"shelf":${JSON.stringify(card)},"forget":null}`;
const forget = (query: string) => `{"note":null,"shelf":null,"forget":${JSON.stringify(query)}}`;

function captureSurface() {
  const sent: string[] = [];
  let sink: ((m: InboundMessage) => void) | undefined;
  const plugin: RussellPlugin = {
    id: "fake",
    name: "fake surface",
    setup(ctx) {
      return ctx.surfaces.register({
        id: "fake",
        start(s) {
          sink = s;
        },
        async send(o) {
          sent.push(o.text);
          return { status: "succeeded" };
        },
      });
    },
  };
  const push = (text: string) =>
    sink?.({
      surfaceId: "fake",
      contextId: "t1",
      author: "u",
      text,
      trustLabel: "untrusted",
      isMention: true,
    });
  return { plugin, sent, push };
}

const drain = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

async function bob(surface: RussellPlugin, model: ScriptedModel) {
  return createAgent(
    { agentId: "bob", configVersion: "v0", temperament: BOB, mode: "dryrun", model: "echo" },
    [createInMemoryMemoryPlugin(), model.plugin, surface],
  );
}

test("「忘れて」で本棚から下げ、以降の想起に出てこない", async () => {
  const s = captureSurface();
  // 1ターン目で本棚へ、2ターン目で忘れる。
  const m = scriptedModel((turn) => (turn === 1 ? shelve("金曜の定例は15時から") : forget("定例")));
  const agent = await bob(s.plugin, m);

  s.push("金曜の定例は15時からね");
  await drain();

  s.push("あの定例のことは忘れて");
  await drain();
  // 2ターン目の時点ではまだ想起に載っている（忘れるのはこのターンの後）
  expect(m.conversations.at(-1)?.system).toContain("金曜の定例は15時から");

  s.push("さっきの話は？");
  await drain();
  // 書庫に落ちたので、以降の想起には出てこない
  expect(m.conversations.at(-1)?.system).not.toContain("金曜の定例は15時から");

  await agent.destroy();
});

test("消したとは言わない（実際にやったのは書庫落ち）", async () => {
  const s = captureSurface();
  const m = scriptedModel(forget("この件"));
  const agent = await bob(s.plugin, m);

  s.push("この件は忘れて");
  await drain();

  // 返答を書くのはモデルなので、固定文では保証できない。**人格として渡す**のが保証の実体。
  const persona = m.conversations.at(-1)?.system ?? "";
  expect(persona).toContain("書庫");
  expect(persona).toContain("データは残ります");
  expect(persona).toContain("「消しました」とは言わず");
  expect(persona).toContain("できなかったことをできたと言わない");

  await agent.destroy();
});

test("否定形を巻き込まない（判定の指示に明記されている）", async () => {
  const s = captureSurface();
  const m = scriptedModel(NOTHING);
  const agent = await bob(s.plugin, m);

  s.push("これは絶対に忘れてはいけない");
  await drain();

  // 取り違えないことはモデルの判断なので、指示に載っていることを押さえる。
  // （判定が null を返せば何も起きない、という経路は下の監査で確かめている）
  expect(m.decisions.at(-1)?.system).toContain("「忘れないで」は forget ではない");
  const invoked = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  expect(invoked).not.toContain("shelf.forget");

  await agent.destroy();
});

test("該当が無くても会話は壊れない", async () => {
  const s = captureSurface();
  const m = scriptedModel(forget("存在しない話"));
  const agent = await bob(s.plugin, m);

  s.push("存在しない話のことは忘れて");
  await drain();

  // 0件でも例外にしない。何が起きたかは event で分かる。
  expect(s.sent).toHaveLength(1);
  const invoked = agent.ctx.audit.recent().find((e) => e.payload.tool === "shelf.forget");
  expect(invoked).toBeDefined();

  await agent.destroy();
});

test("忘れる操作も Policy Gate と監査を通る", async () => {
  const s = captureSurface();
  const m = scriptedModel(forget("これ"));
  const agent = await bob(s.plugin, m);

  s.push("これは忘れて");
  await drain();

  const invoked = agent.ctx.audit
    .recent()
    .filter((e) => e.action === "tool.invoked")
    .map((e) => e.payload.tool);
  expect(invoked).toContain("shelf.forget");
  // 来歴は untrusted のまま（他者の発言に起因する操作）。
  // モデルが決めた操作でも、引き金は相手の発言なので trusted に昇格させない（§12-3）。
  const rec = agent.ctx.audit.recent().find((e) => e.payload.tool === "shelf.forget");
  expect(rec?.trustLabel).toBe("untrusted");

  await agent.destroy();
});
