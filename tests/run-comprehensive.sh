#!/usr/bin/env bash
#
# Self-contained comprehensive regression runner:
#   1. Start AFFiNE via Docker Compose
#   2. Wait for health + verify credentials
#   3. Build the MCP server
#   4. Run the comprehensive MCP tool-surface test
#   5. Tear down Docker on exit
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKER_DIR="$PROJECT_DIR/docker"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"

export AFFINE_BASE_URL="${AFFINE_BASE_URL:-http://localhost:3010}"
export AFFINE_HEALTH_MAX_RETRIES="${AFFINE_HEALTH_MAX_RETRIES:-90}"
export AFFINE_HEALTH_INTERVAL_MS="${AFFINE_HEALTH_INTERVAL_MS:-5000}"
export AFFINE_HEALTH_REQUEST_TIMEOUT_MS="${AFFINE_HEALTH_REQUEST_TIMEOUT_MS:-3000}"
export AFFINE_CREDENTIAL_ACQUIRE_RETRIES="${AFFINE_CREDENTIAL_ACQUIRE_RETRIES:-3}"
export AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS="${AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS:-5}"
export AFFINE_AUTH_READY_MAX_RETRIES="${AFFINE_AUTH_READY_MAX_RETRIES:-30}"
export AFFINE_AUTH_READY_INTERVAL_SECONDS="${AFFINE_AUTH_READY_INTERVAL_SECONDS:-3}"
export AFFINE_DOCKER_START_RETRIES="${AFFINE_DOCKER_START_RETRIES:-3}"
export AFFINE_DOCKER_START_RETRY_DELAY_SECONDS="${AFFINE_DOCKER_START_RETRY_DELAY_SECONDS:-3}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/affine-mcp-comprehensive-noconfig}"
export AFFINE_ADMIN_EMAIL="${AFFINE_ADMIN_EMAIL:-test@affine.local}"
export AFFINE_ADMIN_PASSWORD="${AFFINE_ADMIN_PASSWORD:-comprehensivepass123}"
export DB_USERNAME="${DB_USERNAME:-affine}"
export DB_PASSWORD="${DB_PASSWORD:-affinecomprehensive123}"
export DB_DATABASE="${DB_DATABASE:-affine}"

echo "=== Generating test credentials ==="
# shellcheck source=generate-test-env.sh
. "$SCRIPT_DIR/generate-test-env.sh"

cleanup() {
  echo ""
  echo "=== Tearing down Docker containers ==="
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
  force_remove_stack_artifacts
}
trap cleanup EXIT

docker_diagnostics() {
  echo ""
  echo "=== Docker diagnostics (on failure) ==="
  docker compose -f "$COMPOSE_FILE" ps || true
  echo ""
  docker compose -f "$COMPOSE_FILE" logs --no-color --tail=200 affine affine_migration postgres redis || true
}

force_remove_stack_artifacts() {
  docker rm -f affine_test_app affine_test_migration affine_test_postgres affine_test_redis >/dev/null 2>&1 || true
  docker volume rm docker_affine_postgres_data docker_affine_config docker_affine_storage >/dev/null 2>&1 || true
  docker network rm docker_default >/dev/null 2>&1 || true
}

wait_for_stack_teardown() {
  local attempt

  for ((attempt = 1; attempt <= 15; attempt++)); do
    if ! docker ps -a --format '{{.Names}}' | grep -q '^affine_test_'; then
      return 0
    fi
    sleep 1
  done

  echo "[comprehensive] WARNING: AFFiNE test containers still appear to exist after teardown wait."
  docker ps -a --format '{{.Names}}\t{{.Status}}' | grep '^affine_test_' || true
  return 1
}

wait_for_auth_ready() {
  local attempt
  local setup_status
  local sign_in_status
  local base_url="${AFFINE_BASE_URL%/}"
  local payload
  payload=$(printf '{"email":"%s","password":"%s"}' "$AFFINE_ADMIN_EMAIL" "$AFFINE_ADMIN_PASSWORD")

  for ((attempt = 1; attempt <= AFFINE_AUTH_READY_MAX_RETRIES; attempt++)); do
    setup_status="$(
      curl -sS -o /tmp/affine-comprehensive-setup-response.txt -w "%{http_code}" \
        -H "Content-Type: application/json" \
        -X POST "$base_url/api/setup/create-admin-user" \
        -d "$payload" || true
    )"

    sign_in_status="$(
      curl -sS -o /tmp/affine-comprehensive-signin-response.txt -w "%{http_code}" \
        -H "Content-Type: application/json" \
        -X POST "$base_url/api/auth/sign-in" \
        -d "$payload" || true
    )"

    if [[ "$sign_in_status" == "200" ]]; then
      echo "[comprehensive] AFFiNE auth readiness confirmed after ${attempt} attempt(s) (setup=${setup_status}, sign-in=${sign_in_status})"
      return 0
    fi

    echo "[comprehensive] Auth readiness attempt ${attempt}/${AFFINE_AUTH_READY_MAX_RETRIES}: setup=${setup_status}, sign-in=${sign_in_status}"
    if ((attempt < AFFINE_AUTH_READY_MAX_RETRIES)); then
      sleep "$AFFINE_AUTH_READY_INTERVAL_SECONDS"
    fi
  done

  echo "[comprehensive] ERROR: AFFiNE sign-in endpoint did not become ready in time"
  if [[ -s /tmp/affine-comprehensive-signin-response.txt ]]; then
    echo "[comprehensive] Last sign-in response body (first 500 bytes):"
    head -c 500 /tmp/affine-comprehensive-signin-response.txt
    echo ""
  fi
  docker_diagnostics
  return 1
}

start_docker_stack_with_retry() {
  local attempt
  local exit_code=1
  local status=0

  for ((attempt = 1; attempt <= AFFINE_DOCKER_START_RETRIES; attempt++)); do
    set +e
    docker compose -f "$COMPOSE_FILE" up -d
    status=$?
    set -e
    if ((status == 0)); then
      return 0
    fi

    exit_code=$status
    echo "[comprehensive] Docker bootstrap failed (attempt ${attempt}/${AFFINE_DOCKER_START_RETRIES}, exit ${exit_code})"
    docker_diagnostics
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
    force_remove_stack_artifacts
    wait_for_stack_teardown || true

    if ((attempt < AFFINE_DOCKER_START_RETRIES)); then
      echo "[comprehensive] Retrying Docker bootstrap in ${AFFINE_DOCKER_START_RETRY_DELAY_SECONDS}s..."
      sleep "$AFFINE_DOCKER_START_RETRY_DELAY_SECONDS"
    fi
  done

  return "$exit_code"
}

export AFFINE_EMAIL="$AFFINE_ADMIN_EMAIL"
export AFFINE_PASSWORD="$AFFINE_ADMIN_PASSWORD"
export AFFINE_LOGIN_AT_START="${AFFINE_LOGIN_AT_START:-sync}"

docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
force_remove_stack_artifacts
wait_for_stack_teardown || true

echo "=== Starting AFFiNE via Docker Compose ==="
start_docker_stack_with_retry

echo ""
echo "=== Verifying AFFiNE auth readiness ==="
wait_for_auth_ready

echo ""
echo "=== Building MCP server ==="
cd "$PROJECT_DIR"
npm run build

echo ""
echo "=== Re-checking AFFiNE auth readiness ==="
wait_for_auth_ready

echo ""
echo "=== Running comprehensive MCP regression ==="
node "$PROJECT_DIR/test-comprehensive.mjs"

echo ""
echo "=== Comprehensive regression completed successfully ==="
