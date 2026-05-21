#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker first, then rerun this script."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required. Install the docker compose plugin, then rerun this script."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
  echo "Edit .env and set LIBRENMS_URL and LIBRENMS_TOKEN, then rerun:"
  echo "  ./bootstrap.sh"
  exit 0
fi

if grep -q "replace_with_librenms_api_token" .env; then
  echo "Update LIBRENMS_TOKEN in .env before starting."
  exit 1
fi

docker compose up -d --build

echo
echo "LibreNMS NetMap is starting."
echo "Open: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):8088"
echo "Local: http://localhost:8088"
