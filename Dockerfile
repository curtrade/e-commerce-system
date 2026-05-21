# syntax=docker/dockerfile:1.7
# Single multi-stage Dockerfile for all four Nest apps in this monorepo.
# Pass --build-arg SERVICE=orders|payments|inventory|notifications.

ARG NODE_VERSION=22.12-alpine3.20

# --- deps -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
ARG SERVICE
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json tsconfig.build.json nest-cli.json package.json ./
COPY libs ./libs
COPY apps ./apps
COPY migrations ./migrations
COPY tracing.js ./
RUN test -n "$SERVICE" || (echo "ERROR: SERVICE build-arg required" && exit 1)
RUN npx nest build ${SERVICE}
RUN npm prune --omit=dev

# --- runtime --------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE_NAME=${SERVICE}
WORKDIR /app
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/migrations ./migrations
COPY --from=build --chown=app:app /app/tracing.js ./
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
# Nest monorepo emits to dist/apps/<svc>/apps/<svc>/src/main.js (paths preserved from baseUrl).
CMD ["sh", "-c", "node dist/apps/${SERVICE_NAME}/apps/${SERVICE_NAME}/src/main.js"]
