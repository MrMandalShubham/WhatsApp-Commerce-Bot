FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json ./
COPY apps/tracking/package.json ./apps/tracking/
RUN pnpm install --no-frozen-lockfile

FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/tracking/node_modules ./apps/tracking/node_modules
COPY . .
WORKDIR /app/apps/tracking
EXPOSE 3002
CMD ["pnpm", "dev"]

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/tracking/node_modules ./apps/tracking/node_modules
COPY . .
RUN pnpm --filter @wcb/tracking build

FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /app/apps/tracking/.next/standalone ./
COPY --from=build /app/apps/tracking/.next/static ./apps/tracking/.next/static
COPY --from=build /app/apps/tracking/public ./apps/tracking/public
EXPOSE 3002
CMD ["node", "apps/tracking/server.js"]
