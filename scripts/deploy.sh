#!/usr/bin/env bash
# Pull the latest main, install, and reload the API under PM2.
#
# Run on the EC2 instance (GitHub Actions runs it over SSH on every push to
# main). Safe to run by hand too:  bash scripts/deploy.sh
#
# Exits non-zero — and leaves the previous process running — if anything
# fails before the reload, so a bad push never takes the API down.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${DEPLOY_BRANCH:-main}"
PM2_NAME="zennara-api"

cd "$APP_DIR"
echo "▶ Deploying $BRANCH into $APP_DIR"

# 1. Code — hard reset to the remote so a manual edit on the box can't block a pull.
git fetch --prune origin
BEFORE=$(git rev-parse --short HEAD)
git reset --hard "origin/$BRANCH"
AFTER=$(git rev-parse --short HEAD)
echo "▶ $BEFORE → $AFTER"

# 2. Dependencies — only when the lockfile changed (npm ci is slow).
if [ "$BEFORE" != "$AFTER" ] && git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  echo "▶ package-lock.json unchanged — skipping npm ci"
else
  npm ci --omit=dev --no-audit --no-fund
fi

# 3. Sanity — the app must at least load before we swap it in.
node -e "require('./server.js')" >/dev/null 2>&1 &
LOADER=$!
sleep 4
if kill -0 "$LOADER" 2>/dev/null; then kill "$LOADER"; else
  echo "✖ server.js failed to load — not reloading PM2" >&2; exit 1
fi

# 4. Reload (zero-downtime) or first start.
mkdir -p logs
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save >/dev/null

# 5. Health — wait for the port to answer.
PORT=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]'); PORT="${PORT:-8000}"
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "✔ zennara-api is up on :$PORT at $AFTER"; exit 0
  fi
  sleep 2
done
echo "✖ API did not answer on :$PORT after reload — check: pm2 logs $PM2_NAME" >&2
exit 1
