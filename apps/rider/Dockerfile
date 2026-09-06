FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json ./
COPY apps/rider/package.json ./apps/rider/
RUN pnpm install --no-frozen-lockfile

FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/rider/node_modules ./apps/rider/node_modules
COPY . .
WORKDIR /app/apps/rider
EXPOSE 3001
CMD ["pnpm", "dev"]

FROM base AS build
# NEXT_PUBLIC_* values are compiled into the client bundle here, so they must
# be present at build time. Railway exposes service variables as build args.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/rider/node_modules ./apps/rider/node_modules
COPY . .
RUN pnpm --filter @wcb/rider build

FROM base AS prod
ENV NODE_ENV=production
# Railway injects PORT; bind on all interfaces so its proxy can reach us.
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/rider/.next/standalone ./
COPY --from=build /app/apps/rider/.next/static ./apps/rider/.next/static
COPY --from=build /app/apps/rider/public ./apps/rider/public
EXPOSE 3001
CMD ["node", "apps/rider/server.js"]
