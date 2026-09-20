#!/bin/bash
# One-time restore of the exported funkfactoryos database (01-schema.sql + 02-data.sql,
# git-ignored, placed here manually) into the homelab funkfactoryos-db container.
#
# Run from anywhere, after `docker compose up -d funkfactoryos-db` on the host that
# runs the ffmg-builder stack (assistant-vm / 192.168.0.94).
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

for f in 01-schema.sql 02-data.sql; do
  if [ ! -f "$SCRIPT_DIR/$f" ]; then
    echo "Missing $SCRIPT_DIR/$f — copy the exported dump here first." >&2
    exit 1
  fi
done

cd "$REPO_ROOT"
echo "Restoring schema..."
docker compose exec -T funkfactoryos-db psql -U postgres -d funkfactoryos -v ON_ERROR_STOP=1 < "$SCRIPT_DIR/01-schema.sql"
echo "Restoring data..."
docker compose exec -T funkfactoryos-db psql -U postgres -d funkfactoryos -v ON_ERROR_STOP=1 < "$SCRIPT_DIR/02-data.sql"
echo "Database restored."
