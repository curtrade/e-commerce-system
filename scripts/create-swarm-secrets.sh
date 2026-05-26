#!/bin/sh
set -euo pipefail

# Creates Docker Swarm secrets from /opt/ecommerce/.env.secrets
# Run once on the Swarm manager during initial setup.
# To rotate: docker secret rm <name> && re-run this script,
# then redeploy the stack.

ENV_FILE="${1:-/opt/ecommerce/.env.secrets}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found"
  echo "Usage: $0 [path-to-env-file]"
  exit 1
fi

SECRETS="
  database_url_orders
  database_url_payments
  database_url_inventory
  database_url_notifications
  redis_url_orders
  redis_url_payments
  redis_url_inventory
  redis_url_notifications
  kafka_brokers
"

for name in $SECRETS; do
  var=$(echo "$name" | tr '[:lower:]' '[:upper:]')
  value=$(grep "^${var}=" "$ENV_FILE" | cut -d= -f2-)

  if [ -z "$value" ]; then
    echo "SKIP $name (${var} not found in $ENV_FILE)"
    continue
  fi

  if docker secret inspect "$name" >/dev/null 2>&1; then
    echo "EXISTS $name (remove first to rotate: docker secret rm $name)"
  else
    printf '%s' "$value" | docker secret create "$name" -
    echo "CREATED $name"
  fi
done
