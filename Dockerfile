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
COPY tracing.js ./
RUN test -n "$SERVICE" || (echo "ERROR: SERVICE build-arg required" && exit 1)
# Generate Prisma client for the active service (no-op when the service has no schema yet).
RUN if [ -f "apps/${SERVICE}/prisma/schema.prisma" ]; then \
      npx prisma generate --schema "apps/${SERVICE}/prisma/schema.prisma"; \
    fi
RUN npx nest build ${SERVICE}
RUN npm prune --omit=dev
# Stage the service's prisma directory (if any) at a stable path so the runtime
# stage can COPY it unconditionally — Docker COPY has no native if-exists.
RUN mkdir -p /app/_prisma && \
    if [ -d "apps/${SERVICE}/prisma" ]; then \
      cp -r "apps/${SERVICE}/prisma/." /app/_prisma/; \
    fi

# --- runtime --------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE_NAME=${SERVICE}
WORKDIR /app
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/_prisma ./_prisma
COPY --from=build --chown=app:app /app/tracing.js ./
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
# Nest monorepo emits to dist/apps/<svc>/apps/<svc>/src/main.js (paths preserved from baseUrl).
CMD ["sh", "-c", "node dist/apps/${SERVICE_NAME}/apps/${SERVICE_NAME}/src/main.js"]
