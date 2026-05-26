# Single multi-stage Dockerfile for all four Nest apps in this monorepo.
# Pass --build-arg SERVICE=orders|payments|inventory|notifications.

ARG NODE_VERSION=22.16-alpine3.21

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
# Stage the service's prisma directory (if any) at a stable path so the runtime
# stage can COPY it unconditionally — Docker COPY has no native if-exists.
RUN mkdir -p /app/_prisma && \
    if [ -d "apps/${SERVICE}/prisma" ]; then \
      cp -r "apps/${SERVICE}/prisma/." /app/_prisma/; \
    fi
# Stash prisma CLI before pruning (used by migrate stage only).
RUN cp -r node_modules/prisma /tmp/prisma-cli
RUN npm prune --omit=dev

# --- migrate --------------------------------------------------------------
# Lightweight stage for `prisma migrate deploy` — includes the CLI that the
# runtime stage intentionally excludes (~50 MB savings per service image).
FROM node:${NODE_VERSION} AS migrate
ARG SERVICE
WORKDIR /app
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /tmp/prisma-cli ./node_modules/prisma
COPY --from=build --chown=app:app /app/_prisma ./_prisma
COPY --from=build --chown=app:app /app/package.json ./
USER app
CMD ["sh", "-c", "for i in 1 2 3; do npx prisma migrate deploy --schema=_prisma/schema.prisma && exit 0; echo \"migrate attempt $i failed, retrying in 3s...\"; sleep 3; done; exit 1"]

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
COPY --chown=app:app scripts/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["sh", "-c", "node dist/apps/${SERVICE_NAME}/apps/${SERVICE_NAME}/src/main.js"]
