# Russell の実行イメージ。**プラットフォーム非依存**（B-2）——Railway / Fly.io / Cloud Run /
# 素の VM のどれでも、Dockerfile と環境変数だけで成立する形を保つ。
#
# **app と worker は同じイメージで、コマンドだけ違う**（§2 の2プロセス構成）。
# 別イメージにすると、依存のズレが「片方だけ動く」形で出る。落ち方が違うので
# **プロセスは分ける**が、中身は分けない。
FROM node:22-slim AS build

RUN corepack enable
WORKDIR /app

# 依存を先に入れてレイヤキャッシュを効かせる
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY plugins ./plugins
COPY examples ./examples
COPY apps ./apps
COPY tsconfig.base.json tsconfig.json turbo.json biome.json ./

RUN pnpm install --frozen-lockfile && pnpm build

# 本番の既定。**開発用のモデル経路（Claude Code CLI）はここで拒否される**ので、
# ANTHROPIC_API_KEY が要る（#75）。
ENV NODE_ENV=production

# 既定は app。worker / dispatcher は command を差し替えて同じイメージを使う:
#   node apps/worker/dist/dispatch.js --watch   # 定期実行（§5.1）
#   node apps/agent/dist/migrate.js             # マイグレーション（デプロイの前段）
CMD ["node", "apps/agent/dist/main.js"]
