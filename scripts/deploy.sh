#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
FRONTEND_DIR="$REPO_DIR/frontend"
PROCESS_NAME="${PROCESS_NAME:-trident-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

# Everything this script prints also goes to a file on the droplet.
#
# Without it the only record of a deploy is the GitHub Action log, so on the
# machine itself there is no way to tell a finished deploy from one still
# building — and `git log` is no help, because the reset happens in the first
# seconds while the migrations run ninety seconds later. Reading the repo state
# mid-deploy and concluding the migration step had failed is exactly the
# mistake this file exists to prevent (2026-07-31).
#
# Falls back to the repo's parent directory when /var/log is not writable, so a
# permissions problem degrades the logging rather than the deploy.
DEPLOY_LOG="${DEPLOY_LOG:-/var/log/trident-deploy.log}"
if ! { [ -e "$DEPLOY_LOG" ] && [ -w "$DEPLOY_LOG" ]; } &&
   ! touch "$DEPLOY_LOG" 2>/dev/null; then
  DEPLOY_LOG="$(dirname "$REPO_DIR")/trident-deploy.log"
  touch "$DEPLOY_LOG" 2>/dev/null || DEPLOY_LOG=/dev/null
fi
exec > >(tee -a "$DEPLOY_LOG") 2>&1

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# A deploy that dies mid-way must say so in the file. Without this the log ends
# on whatever step failed and reads like a deploy still in progress.
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    log "DEPLOY FAILED (exit $code) at commit $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  fi
}
trap on_exit EXIT

log "=== DEPLOY START $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo '?') → log $DEPLOY_LOG"

require_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    log "Missing required file: $file"
    exit 1
  fi
}

has_npm_script() {
  local dir="$1"
  local script_name="$2"
  node - "$dir/package.json" "$script_name" <<'NODE' >/dev/null
const pkg = require(process.argv[2]);
const script = process.argv[3];
process.exit(pkg && pkg.scripts && pkg.scripts[script] ? 0 : 1);
NODE
}

require_file "$BACKEND_DIR/.env"
require_file "$FRONTEND_DIR/.env.production"

log "Cleaning previous build artifacts"
# A prior manual deploy run as root leaves dist owned by root, which the
# unprivileged deploy user cannot rm — that silently aborts the automated
# deploy before it rebuilds. Fall back to `sudo git clean` (git is NOPASSWD
# for the deploy user; rm is not) to remove the gitignored artifacts
# regardless of owner.
rm -rf "$BACKEND_DIR/dist" "$FRONTEND_DIR/dist" 2>/dev/null || \
  sudo git -C "$REPO_DIR" clean -qfdx -- backend/dist frontend/dist

log "Installing backend dependencies"
npm --prefix "$BACKEND_DIR" ci

log "Installing frontend dependencies"
npm --prefix "$FRONTEND_DIR" ci

log "Building backend"
npm --prefix "$BACKEND_DIR" run build

log "Building frontend"
npm --prefix "$FRONTEND_DIR" run build

if has_npm_script "$BACKEND_DIR" "db:migrate"; then
  log "Running TypeORM migrations"
  npm --prefix "$BACKEND_DIR" run db:migrate
else
  log "Missing required npm script: db:migrate"
  exit 1
fi

entry=""
if [ -f "$BACKEND_DIR/dist/main.js" ]; then
  entry="$BACKEND_DIR/dist/main.js"
elif [ -f "$BACKEND_DIR/dist/src/main.js" ]; then
  entry="$BACKEND_DIR/dist/src/main.js"
else
  log "Unable to find backend entrypoint in dist"
  exit 1
fi

log "Restarting PM2 process using $entry"
sudo pm2 delete "$PROCESS_NAME" >/dev/null 2>&1 || true
sudo pm2 start "$entry" --name "$PROCESS_NAME" --cwd "$BACKEND_DIR"
sudo pm2 save >/dev/null

log "Reloading nginx"
sudo nginx -t
sudo systemctl reload nginx

log "Waiting for backend healthcheck"
for attempt in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "Backend healthcheck passed"
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    log "Backend healthcheck failed"
    sudo pm2 logs "$PROCESS_NAME" --lines 80 --nostream || true
    exit 1
  fi
  sleep 2
done

log "=== DEPLOY COMPLETE at commit $(git -C "$REPO_DIR" rev-parse --short HEAD)"
