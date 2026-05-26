#!/bin/sh
set -e

# Read Docker Swarm secrets mounted at /run/secrets/<name>
# and export them as environment variables.
# File name → ENV VAR: /run/secrets/database_url → DATABASE_URL
for secret in /run/secrets/*; do
  [ -f "$secret" ] || continue
  var=$(basename "$secret" | tr '[:lower:]' '[:upper:]')
  export "$var"="$(cat "$secret")"
done

exec "$@"
