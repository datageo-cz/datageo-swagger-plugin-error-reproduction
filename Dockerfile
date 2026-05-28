# Minimal pnpm + turbo + NestJS multi-stage Dockerfile for the reproduction.
# `pnpm deploy --filter @repro/api --prod` produces a self-contained app bundle
# that does NOT mirror the original monorepo layout — there is no
# `packages/shared/dist/...` next to the deployed app. At runtime, the
# @nestjs/swagger plugin's emitted relative require() fails with MODULE_NOT_FOUND.

FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
ENV TURBO_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@11.1.0 --activate
RUN pnpm add -g turbo

WORKDIR /build


FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN turbo build --filter @repro/api
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter @repro/api --prod /deploy


FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /deploy /app
EXPOSE 3000
CMD ["node", "dist/main"]
