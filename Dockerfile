# Russell 実行ホスト（app）。プラットフォーム非依存コンテナ（B-2）。
# シングルステージの素朴な構成。実装フェーズで multi-stage / 本番最適化する。
FROM node:22-slim

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

# app（Slack Gateway + Agent Core + Policy Gate）。worker は将来別プロセス/別サービスに分離（§2）。
CMD ["node", "apps/agent/dist/main.js"]
