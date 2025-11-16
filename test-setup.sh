#!/usr/bin/env bash

# YouTube Live Streaming Scheduler - Environment & Stack Validator
# This script checks local prerequisites and the containerized stack.
# It prints colored results and suggests fixes for failures.

set -u

############################################
# Colors
############################################
if command -v tput >/dev/null 2>&1; then
  GREEN="$(tput setaf 2)"
  RED="$(tput setaf 1)"
  YELLOW="$(tput setaf 3)"
  BLUE="$(tput setaf 4)"
  BOLD="$(tput bold)"
  RESET="$(tput sgr0)"
else
  GREEN="\033[32m"
  RED="\033[31m"
  YELLOW="\033[33m"
  BLUE="\033[34m"
  BOLD="\033[1m"
  RESET="\033[0m"
fi

ok()   { echo -e "${GREEN}✓${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; SUGGESTION="$2"; [ -n "$SUGGESTION" ] && echo -e "  ${YELLOW}→ Suggestion:${RESET} $SUGGESTION"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn() { echo -e "${YELLOW}!${RESET} $1"; [ -n "$2" ] && echo -e "  ${YELLOW}→ Note:${RESET} $2"; WARN_COUNT=$((WARN_COUNT+1)); }

FAIL_COUNT=0
WARN_COUNT=0

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"

header() {
  echo -e "\n${BOLD}${BLUE}==> $1${RESET}"
}

############################################
# 1) Docker installed
############################################
header "Check Docker installation"
if command -v docker >/dev/null 2>&1; then
  ok "Docker is installed"
else
  fail "Docker is not installed" "Install Docker: https://docs.docker.com/get-docker/"
fi

############################################
# 2) Docker Compose installed
############################################
header "Check Docker Compose installation"
if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose v2 is available"
elif command -v docker-compose >/dev/null 2>&1; then
  ok "Legacy docker-compose is available"
else
  fail "Docker Compose is not installed" "Install Docker Compose v2 or legacy: https://docs.docker.com/compose/install/"
fi

############################################
# 3) Docker network 'web'
############################################
header "Check Docker network 'web'"
if docker network inspect web >/dev/null 2>&1; then
  ok "Docker network 'web' exists"
else
  fail "Docker network 'web' not found" "Create it: docker network create web"
fi

############################################
# 4) Required files exist
############################################
header "Validate required files"
REQUIRED_FILES=(
  "$ROOT_DIR/docker-compose.yml"
  "$ROOT_DIR/traefik/traefik.yml"
  "$ROOT_DIR/traefik/dynamic-config.yml"
  "$ROOT_DIR/nginx/nginx.conf"
  "$ROOT_DIR/frontend/index.html"
  "$ROOT_DIR/frontend/js/app.js"
  "$ROOT_DIR/frontend/js/config.js"
  "$ROOT_DIR/backend/server.js"
  "$ROOT_DIR/backend/routes/videos.js"
  "$ROOT_DIR/backend/models/Video.js"
  "$ROOT_DIR/.env"
  "$ROOT_DIR/.env.example"
)
for f in "${REQUIRED_FILES[@]}"; do
  if [ -f "$f" ]; then
    ok "Found: ${f#$ROOT_DIR/}"
  else
    fail "Missing: ${f#$ROOT_DIR/}" "Verify repository contents or recreate the file."
  fi
done

############################################
# 5) Port availability: 80, 443, 8080, 3000
############################################
header "Check port availability (localhost)"
is_port_open() {
  local port="$1"
  (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}
check_port() {
  local port="$1"
  if is_port_open "$port"; then
    fail "Port $port appears to be in use" "Identify and stop conflicts (e.g., netstat -tulnp | grep :$port)."
  else
    ok "Port $port is available"
  fi
}
for p in 80 443 8080 3000; do
  check_port "$p"
done

############################################
# 6) Test MongoDB connection (container 'mongo')
############################################
header "Test MongoDB connection"
if docker ps --format '{{.Names}}' | grep -q '^mongo$'; then
  if docker exec mongo mongosh --quiet --eval "db.runCommand({ ping: 1 })" >/dev/null 2>&1; then
    ok "MongoDB responded to ping"
  else
    fail "MongoDB container reachable but ping failed" "Check logs: docker logs mongo; ensure it's healthy."
  fi
else
  fail "MongoDB container 'mongo' is not running" "Start it: docker compose up -d mongo"
fi

############################################
# 7) Test FFmpeg installation in backend container
############################################
header "Test FFmpeg installation"
if docker ps --format '{{.Names}}' | grep -q '^backend$'; then
  if docker exec backend ffmpeg -version >/dev/null 2>&1 && docker exec backend ffprobe -version >/dev/null 2>&1; then
    ok "FFmpeg and ffprobe are available in backend container"
  else
    warn "FFmpeg not found in backend container" "Install FFmpeg in the backend image or ensure host FFmpeg is accessible."
  fi
else
  warn "Backend container is not running" "Start the stack: docker compose up -d; testing FFmpeg on host: ffmpeg -version"
  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    ok "FFmpeg and ffprobe are installed on host"
  else
    fail "FFmpeg not found on host" "Install FFmpeg: https://ffmpeg.org/download.html"
  fi
fi

############################################
# 8) Validate environment variables (.env)
############################################
header "Validate environment variables (.env)"
if [ -f "$ENV_FILE" ]; then
  declare -A env
  # shellcheck disable=SC2162
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^#|^$ ]] && continue
    env["$key"]="${val}"
  done < "$ENV_FILE"

  required=(NODE_ENV PORT MONGODB_URI VIDEOS_PATH MAX_UPLOAD_SIZE DOMAIN ACME_EMAIL)
  for k in "${required[@]}"; do
    if [ -z "${env[$k]:-}" ]; then
      fail "Missing env: $k" "Edit .env and set $k. See .env.example for guidance."
    else
      ok "Env present: $k=${env[$k]}"
    fi
  done

  # Placeholder checks
  [[ "${env[DOMAIN]:-}" == "yourdomain.com" ]] && warn "DOMAIN is a placeholder" "Set your actual domain."
  [[ "${env[ACME_EMAIL]:-}" == "your-email@example.com" ]] && warn "ACME_EMAIL is a placeholder" "Set a valid email for Let's Encrypt."
else
  fail ".env file not found" "Copy .env.example to .env and customize."
fi

############################################
# 9) Check disk space for 'videos' directory
############################################
header "Check disk space for videos/"
VID_DIR="$ROOT_DIR/videos"
if [ -d "$VID_DIR" ]; then
  if [ -w "$VID_DIR" ]; then
    ok "videos/ directory exists and is writable"
  else
    fail "videos/ directory is not writable" "Fix permissions: chmod 775 videos; or run with appropriate user."
  fi
  # Use df to check free space
  if command -v df >/dev/null 2>&1; then
    FREE_KB=$(df -Pk "$VID_DIR" | awk 'NR==2 {print $4}')
    FREE_GB=$(awk "BEGIN {printf \"%.2f\", ${FREE_KB}/1024/1024}")
    ok "Free space: ${FREE_GB} GB"
    # Warn if less than 5GB free
    awk "BEGIN {exit (${FREE_KB} < 5*1024*1024 ? 0 : 1)}" || warn "Low free space (<5GB)" "Free up disk space before uploading large videos."
  else
    warn "df not available" "Skip disk space check. Install coreutils to enable."
  fi
else
  fail "videos/ directory missing" "Create it: mkdir -p videos; it's mounted to backend container."
fi

############################################
# 10) Test API health endpoint
############################################
header "Test API health endpoint"
API_URL="http://localhost:3000/api/health"
if command -v curl >/dev/null 2>&1; then
  HTTP_STATUS=$(curl -s -o /tmp/health.json -w "%{http_code}" "$API_URL" || true)
  if [ "$HTTP_STATUS" = "200" ]; then
    ok "Health endpoint returned 200"
    if grep -q '"status"\s*:\s*"ok"' /tmp/health.json; then
      ok "Backend status is ok"
    else
      warn "Backend reported non-ok status" "Inspect /api/health and backend logs for details."
    fi
    # Show DB status if present
    DB_STATUS=$(grep -o '"db"\s*:\s*"[^"]*"' /tmp/health.json | awk -F '"' '{print $4}')
    [ -n "$DB_STATUS" ] && echo "  DB: $DB_STATUS"
  else
    fail "Health endpoint unreachable (HTTP $HTTP_STATUS)" "Ensure backend is running: docker compose up -d backend"
  fi
else
  warn "curl not installed" "Install curl to test HTTP endpoints."
fi

############################################
# Summary
############################################
echo -e "\n${BOLD}Summary:${RESET} ${GREEN}OK${RESET} checks: $(($((10)) - FAIL_COUNT - WARN_COUNT))  ${YELLOW}WARN${RESET}: ${WARN_COUNT}  ${RED}FAIL${RESET}: ${FAIL_COUNT}"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}Some checks failed.${RESET} Please address the suggestions above and re-run: ${BOLD}./test-setup.sh${RESET}"
  exit 1
else
  echo -e "${GREEN}All critical checks passed.${RESET} You are ready to run docker compose."
  exit 0
fi