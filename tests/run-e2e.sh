#!/usr/bin/env bash
#
# E2E test orchestration:
#   1. Start AFFiNE via Docker Compose
#   2. Wait for health + acquire credentials
#   3. Build the MCP server
#   4. Run MCP database creation test (email/password auth)
#   5. Run MCP bearer token auth test
#   6. Run MCP HTTP email/password multi-session test
#   7. Run MCP tag visibility setup test
#   8. Run MCP data-view setup test
#   9. Run Playwright UI verification (all scenarios)
#  10. Tear down Docker (on exit)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKER_DIR="$PROJECT_DIR/docker"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"

find_free_port() {
  node -e 'const net=require("net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const {port}=server.address();console.log(port);server.close();});'
}

# --- Configuration ---
export PORT="${PORT:-$(find_free_port)}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-affine_mcp_e2e_${PORT}_$$}"
export AFFINE_BASE_URL="${AFFINE_BASE_URL:-http://localhost:${PORT}}"
export AFFINE_HEALTH_MAX_RETRIES="${AFFINE_HEALTH_MAX_RETRIES:-90}"
export AFFINE_HEALTH_INTERVAL_MS="${AFFINE_HEALTH_INTERVAL_MS:-5000}"
export AFFINE_HEALTH_REQUEST_TIMEOUT_MS="${AFFINE_HEALTH_REQUEST_TIMEOUT_MS:-3000}"
export AFFINE_CREDENTIAL_ACQUIRE_RETRIES="${AFFINE_CREDENTIAL_ACQUIRE_RETRIES:-3}"
export AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS="${AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS:-5}"
export AFFINE_AUTH_READY_MAX_RETRIES="${AFFINE_AUTH_READY_MAX_RETRIES:-30}"
export AFFINE_AUTH_READY_INTERVAL_SECONDS="${AFFINE_AUTH_READY_INTERVAL_SECONDS:-3}"
export AFFINE_DOCKER_START_RETRIES="${AFFINE_DOCKER_START_RETRIES:-3}"
export AFFINE_DOCKER_RETRY_DELAY_SECONDS="${AFFINE_DOCKER_RETRY_DELAY_SECONDS:-5}"

# Generate random credentials (writes docker/.env, exports env vars)
echo "=== Generating test credentials ==="
# shellcheck source=generate-test-env.sh
. "$SCRIPT_DIR/generate-test-env.sh"

# --- Cleanup on exit ---
cleanup() {
  echo ""
  echo "=== Tearing down Docker containers ==="
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

compose_container_id() {
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps -aq "$1" 2>/dev/null || true
}

docker_diagnostics() {
  echo ""
  echo "=== Docker diagnostics (on failure) ==="
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps || true
  echo ""
  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" logs --no-color --tail=200 affine affine_migration postgres redis || true
}

docker_compose_with_retry() {
  local description="$1"
  shift
  local attempt
  local output_file
  output_file="$(mktemp)"

  for ((attempt = 1; attempt <= AFFINE_DOCKER_START_RETRIES; attempt++)); do
    if docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@" >"$output_file" 2>&1; then
      cat "$output_file"
      rm -f "$output_file"
      return 0
    fi

    echo "[e2e] ${description} failed (attempt ${attempt}/${AFFINE_DOCKER_START_RETRIES})"
    cat "$output_file"
    docker_diagnostics
    docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true

    if ((attempt < AFFINE_DOCKER_START_RETRIES)); then
      echo "[e2e] Retrying ${description} in ${AFFINE_DOCKER_RETRY_DELAY_SECONDS}s..."
      sleep "$AFFINE_DOCKER_RETRY_DELAY_SECONDS"
    fi
  done

  rm -f "$output_file"
  return 1
}

wait_for_container_health() {
  local service_name="$1"
  local max_attempts="${2:-30}"
  local sleep_seconds="${3:-2}"
  local attempt
  local container_id
  local status

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    container_id="$(compose_container_id "$service_name")"
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      echo "[e2e] Service ${service_name} ready after ${attempt} attempt(s) (status=${status})"
      return 0
    fi

    echo "[e2e] Waiting for ${service_name}: attempt ${attempt}/${max_attempts} (status=${status:-missing})"
    sleep "$sleep_seconds"
  done

  echo "[e2e] ERROR: service ${service_name} did not become ready"
  docker_diagnostics
  return 1
}

wait_for_container_running() {
  local service_name="$1"
  local max_attempts="${2:-30}"
  local sleep_seconds="${3:-2}"
  local attempt
  local container_id
  local status

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    container_id="$(compose_container_id "$service_name")"
    status="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
    if [[ "$status" == "running" ]]; then
      echo "[e2e] Service ${service_name} container running after ${attempt} attempt(s)"
      return 0
    fi

    echo "[e2e] Waiting for ${service_name} container: attempt ${attempt}/${max_attempts} (status=${status:-missing})"
    sleep "$sleep_seconds"
  done

  echo "[e2e] ERROR: service ${service_name} container did not reach running state"
  docker_diagnostics
  return 1
}

wait_for_container_exit_zero() {
  local service_name="$1"
  local max_attempts="${2:-30}"
  local sleep_seconds="${3:-2}"
  local attempt
  local container_id
  local status
  local exit_code

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    container_id="$(compose_container_id "$service_name")"
    status="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$container_id" 2>/dev/null || true)"

    if [[ "$status" == "exited" && "$exit_code" == "0" ]]; then
      echo "[e2e] Service ${service_name} completed successfully after ${attempt} attempt(s)"
      return 0
    fi

    echo "[e2e] Waiting for ${service_name} completion: attempt ${attempt}/${max_attempts} (status=${status:-missing}, exit=${exit_code:-missing})"
    sleep "$sleep_seconds"
  done

  echo "[e2e] ERROR: service ${service_name} did not complete successfully"
  docker_diagnostics
  return 1
}

start_docker_stack() {
  docker_compose_with_retry "base service startup" up -d postgres redis
  wait_for_container_health postgres 30 2
  wait_for_container_health redis 30 2

  docker_compose_with_retry "migration startup" up -d --no-deps affine_migration
  wait_for_container_exit_zero affine_migration 45 2

  docker_compose_with_retry "app startup" up -d --no-deps affine
  wait_for_container_running affine 45 2
}

acquire_credentials_with_retry() {
  local attempt
  local exit_code=1

  for ((attempt = 1; attempt <= AFFINE_CREDENTIAL_ACQUIRE_RETRIES; attempt++)); do
    if node "$SCRIPT_DIR/acquire-credentials.mjs"; then
      return 0
    fi

    exit_code=$?
    echo "[e2e] Credential acquisition failed (attempt ${attempt}/${AFFINE_CREDENTIAL_ACQUIRE_RETRIES}, exit ${exit_code})"
    docker_diagnostics

    if ((attempt < AFFINE_CREDENTIAL_ACQUIRE_RETRIES)); then
      echo "[e2e] Retrying credential acquisition in ${AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS}s..."
      sleep "$AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS"
    fi
  done

  return "$exit_code"
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
      curl -sS -o /tmp/affine-setup-response.txt -w "%{http_code}" \
        -H "Content-Type: application/json" \
        -X POST "$base_url/api/setup/create-admin-user" \
        -d "$payload" || true
    )"

    sign_in_status="$(
      curl -sS -o /tmp/affine-signin-response.txt -w "%{http_code}" \
        -H "Content-Type: application/json" \
        -X POST "$base_url/api/auth/sign-in" \
        -d "$payload" || true
    )"

    if [[ "$sign_in_status" == "200" ]]; then
      echo "[e2e] AFFiNE auth readiness confirmed after ${attempt} attempt(s) (setup=${setup_status}, sign-in=${sign_in_status})"
      return 0
    fi

    echo "[e2e] Auth readiness attempt ${attempt}/${AFFINE_AUTH_READY_MAX_RETRIES}: setup=${setup_status}, sign-in=${sign_in_status}"
    if ((attempt < AFFINE_AUTH_READY_MAX_RETRIES)); then
      sleep "$AFFINE_AUTH_READY_INTERVAL_SECONDS"
    fi
  done

  echo "[e2e] ERROR: AFFiNE sign-in endpoint did not become ready in time"
  if [[ -s /tmp/affine-signin-response.txt ]]; then
    echo "[e2e] Last sign-in response body (first 500 bytes):"
    head -c 500 /tmp/affine-signin-response.txt
    echo ""
  fi
  docker_diagnostics
  return 1
}

ensure_affine_ui_ready() {
  local base_url="${AFFINE_BASE_URL%/}"

  if curl -fsS --max-time "$((AFFINE_HEALTH_REQUEST_TIMEOUT_MS / 1000))" "$base_url/" >/dev/null 2>&1; then
    echo "[e2e] AFFiNE UI already reachable for Playwright"
    return 0
  fi

  echo "[e2e] AFFiNE UI is not reachable before Playwright; attempting service recovery..."
  docker_diagnostics

  docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d --no-deps affine
  acquire_credentials_with_retry
  wait_for_auth_ready
}

# --- Step 0: Clean up any stale containers from previous runs ---
docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true

# --- Step 1: Start Docker ---
echo "=== Starting AFFiNE via Docker Compose ==="
start_docker_stack

# --- Step 2: Wait for health + verify credentials ---
echo ""
echo "=== Waiting for AFFiNE to become healthy ==="
acquire_credentials_with_retry
echo ""
echo "=== Verifying AFFiNE auth readiness ==="
wait_for_auth_ready

# --- Step 3: Build MCP server ---
echo ""
echo "=== Building MCP server ==="
cd "$PROJECT_DIR"
npm run build

# --- Step 4: Run MCP database creation test ---
echo ""
echo "=== Running MCP database creation test ==="
node "$SCRIPT_DIR/test-database-creation.mjs"

# --- Step 5: Run MCP bearer token auth test ---
echo ""
echo "=== Running MCP bearer token auth test ==="
node "$SCRIPT_DIR/test-bearer-auth.mjs"

# --- Step 6: Run MCP HTTP email/password multi-session test ---
echo ""
echo "=== Running MCP HTTP email/password multi-session test ==="
node "$SCRIPT_DIR/test-http-email-password.mjs"

# --- Step 7: Run MCP HTTP bearer auth test ---
echo ""
echo "=== Running MCP HTTP bearer auth test ==="
node "$SCRIPT_DIR/test-http-bearer.mjs"

# --- Step 8: Run MCP OAuth HTTP auth test ---
echo ""
echo "=== Running MCP OAuth HTTP auth test ==="
node "$SCRIPT_DIR/test-oauth-http.mjs"

# --- Step 9: Run MCP tag visibility setup test ---
echo ""
echo "=== Running MCP tag visibility setup test ==="
node "$SCRIPT_DIR/test-tag-visibility.mjs"

# --- Step 10: Run MCP data-view setup test ---
echo ""
echo "=== Running MCP data-view setup test ==="
node "$SCRIPT_DIR/test-data-view.mjs"

# --- Step 11: Run MCP doc discovery regression test ---
echo ""
echo "=== Running MCP doc discovery regression test ==="
node "$SCRIPT_DIR/test-doc-discovery.mjs"

# --- Step 12: Run Playwright verification ---
echo ""
echo "=== Running Playwright UI verification ==="
ensure_affine_ui_ready
npx playwright test --config "$SCRIPT_DIR/playwright/playwright.config.ts"

echo ""
echo "=== E2E test pipeline completed successfully ==="
