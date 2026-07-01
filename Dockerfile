FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm install -g pnpm@11.7.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs ./docs
COPY examples ./examples
COPY scripts ./scripts
COPY README.md LICENSE ./

RUN pnpm install --frozen-lockfile --ignore-optional
RUN pnpm build

ENV HOST=0.0.0.0
ENV PORT=8080
ENV MACHIAI_STORE=/data/machiai.sqlite

EXPOSE 8080

CMD ["node", "dist/apps/server/src/main.js"]
