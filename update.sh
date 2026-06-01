#!/bin/bash
set -e
cd "$(dirname "$0")"
git pull origin main
docker compose up --build -d
docker image prune -f
echo "ffmg-builder updated and restarted"
