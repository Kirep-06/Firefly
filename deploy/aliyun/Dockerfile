FROM node:22-bookworm-slim

ENV COREPACK_HOME=/opt/corepack
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
COPY src/content/posts /seed-posts
RUN chown -R node:node /app /seed-posts

ENV NODE_ENV=production
USER node

EXPOSE 3000
CMD ["node", "admin/server.mjs"]
