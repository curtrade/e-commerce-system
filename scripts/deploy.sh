#!/bin/sh
set -euo pipefail

# Pre-flight checks (#23)
test -f /opt/ecommerce/.env.secrets || { echo "FATAL: /opt/ecommerce/.env.secrets not found — see docs/production-readiness.md"; exit 1; }
test -f /opt/ecommerce/.env || { echo "FATAL: /opt/ecommerce/.env not found"; exit 1; }

echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin

set -a
. /opt/ecommerce/.env.secrets
. /opt/ecommerce/.env
set +a
export IMAGE_TAG="${IMAGE_TAG}"
export IMAGE_PREFIX="${IMAGE_PREFIX}"

NETWORK="${DEPLOY_NETWORK:-ecommerce_default}"
SERVICES="orders payments inventory notifications"
FAILED=""

for svc in $SERVICES; do
  db_var="DATABASE_URL_$(echo "$svc" | tr '[:lower:]' '[:upper:]')"
  eval db_url="\$$db_var"

  echo "Migrating $svc..."
  if docker run --rm --network "$NETWORK" \
    -e "DATABASE_URL=$db_url" \
    "${IMAGE_PREFIX}-${svc}-migrate:${IMAGE_TAG}"; then
    echo "OK: $svc migration succeeded"
  else
    echo "FAIL: $svc migration failed"
    FAILED="$FAILED $svc"
  fi
done

if [ -n "$FAILED" ]; then
  echo "FATAL: migrations failed for:$FAILED"
  echo "Fix the migrations and re-run. Already-applied migrations are idempotent (forward-only)."
  exit 1
fi

docker stack deploy \
  -c /opt/ecommerce/docker-stack.yml \
  --with-registry-auth ecommerce
