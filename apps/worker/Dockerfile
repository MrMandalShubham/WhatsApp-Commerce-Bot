FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/whatsapp/package.json ./packages/whatsapp/
COPY packages/payments/package.json ./packages/payments/
# Fail on lockfile drift rather than silently re-resolving.
RUN pnpm install --frozen-lockfile

FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/whatsapp/node_modules ./packages/whatsapp/node_modules
COPY --from=deps /app/packages/payments/node_modules ./packages/payments/node_modules
COPY . .
RUN pnpm --filter @wcb/db db:generate && pnpm --filter @wcb/core --filter @wcb/whatsapp --filter @wcb/payments build
WORKDIR /app/apps/worker
CMD ["pnpm", "dev"]

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/whatsapp/node_modules ./packages/whatsapp/node_modules
COPY --from=deps /app/packages/payments/node_modules ./packages/payments/node_modules
COPY . .
RUN pnpm --filter @wcb/db db:generate && pnpm --filter @wcb/core --filter @wcb/whatsapp --filter @wcb/payments build && pnpm --filter @wcb/worker build

FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
