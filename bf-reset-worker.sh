#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8788}"

echo "== Kill anything on port ${PORT} =="
lsof -ti :"${PORT}" | xargs -r kill -9 || true

echo "== Kill any wrangler dev processes =="
ps aux | rg "wrangler dev" | awk '{print $2}' | xargs -r kill -9 || true

echo "== Clear local wrangler tmp/state (safe) =="
rm -rf ~/.wrangler/tmp ~/.wrangler/state || true

echo "== Start worker clean on 0.0.0.0:${PORT} =="
cd "$(dirname "$0")/translation-worker"
exec wrangler dev --local --ip 0.0.0.0 --port "${PORT}"
