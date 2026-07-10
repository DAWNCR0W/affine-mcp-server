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

find_free_port() {
  node -e 'const net=require("net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const {port}=server.address();console.log(port);server.close();});'
}

export PORT="${PORT:-$(find_free_port)}"
export AFFINE_BASE_URL="${AFFINE_BASE_URL:-http://localhost:${PORT}}"
export AFFINE_HEALTH_MAX_RETRIES="${AFFINE_HEALTH_MAX_RETRIES:-90}"
export AFFINE_HEALTH_INTERVAL_MS="${AFFINE_HEALTH_INTERVAL_MS:-5000}"
export AFFINE_HEALTH_REQUEST_TIMEOUT_MS="${AFFINE_HEALTH_REQUEST_TIMEOUT_MS:-3000}"
export AFFINE_CREDENTIAL_ACQUIRE_RETRIES="${AFFINE_CREDENTIAL_ACQUIRE_RETRIES:-3}"
export AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS="${AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS:-5}"
export AFFINE_AUTH_READY_MAX_RETRIES="${AFFINE_AUTH_READY_MAX_RETRIES:-30}"
export AFFINE_AUTH_READY_INTERVAL_SECONDS="${AFFINE_AUTH_READY_INTERVAL_SECONDS:-3}"
export AFFINE_DOCKER_START_RETRIES="${AFFINE_DOCKER_START_RETRIES:-3}"
export AFFINE_DOCKER_START_RETRY_DELAY_SECONDS="${AFFINE_DOCKER_START_RETRY_DELAY_SECONDS:-3}"

# Fail before Docker setup or authentication if the selected target is unsafe.
AFFINE_TEST_RUN_ID="$(node "$SCRIPT_DIR/assert-destructive-test-target.mjs" --print-run-id)"
compose_run_id="$(printf '%s' "$AFFINE_TEST_RUN_ID" | tr '[:upper:].' '[:lower:]_')"
export COMPOSE_PROJECT_NAME="affine_mcp_comprehensive_${compose_run_id}"
AFFINE_TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/affine-mcp-comprehensive.XXXXXX")"
export AFFINE_TEST_RUN_ID AFFINE_TEST_TMP_DIR
export XDG_CONFIG_HOME="$AFFINE_TEST_TMP_DIR/xdg"

cleanup_test_files() {
  if [[ "${AFFINE_TEST_ENV_FILE_OWNED:-0}" == "1" && -n "${AFFINE_TEST_ENV_FILE:-}" ]]; then
    rm -f -- "$AFFINE_TEST_ENV_FILE"
  fi
  rm -rf -- "$AFFINE_TEST_TMP_DIR"
}
trap cleanup_test_files EXIT

echo "=== Generating test credentials ==="
# shellcheck source=tests/generate-test-env.sh
. "$SCRIPT_DIR/generate-test-env.sh"

compose() {
  docker compose --env-file "$AFFINE_TEST_ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  echo ""
  echo "=== Tearing down Docker containers ==="
  compose down -v --remove-orphans 2>/dev/null || true
  cleanup_test_files
}
trap cleanup EXIT

docker_diagnostics() {
  echo ""
  echo "=== Docker diagnostics (on failure) ==="
  compose ps || true
  echo ""
  compose logs --no-color --tail=200 affine affine_migration postgres redis || true
}

wait_for_auth_ready() {
  local attempt
  local setup_status
  local sign_in_status
  local base_url="${AFFINE_BASE_URL%/}"
  local payload
  local setup_response="$AFFINE_TEST_TMP_DIR/setup-response.txt"
  local sign_in_response="$AFFINE_TEST_TMP_DIR/sign-in-response.txt"
  payload="$(node -e 'process.stdout.write(JSON.stringify({email:process.env.AFFINE_ADMIN_EMAIL,password:process.env.AFFINE_ADMIN_PASSWORD}))')"

  for ((attempt = 1; attempt <= AFFINE_AUTH_READY_MAX_RETRIES; attempt++)); do
    setup_status="$(
      curl -sS -o "$setup_response" -w "%{http_code}" \
        -H "Content-Type: application/json" \
        -X POST "$base_url/api/setup/create-admin-user" \
        -d "$payload" || true
    )"

    sign_in_status="$(
      curl -sS -o "$sign_in_response" -w "%{http_code}" \
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
  if [[ -s "$sign_in_response" ]]; then
    echo "[comprehensive] Last sign-in response body (first 500 bytes):"
    head -c 500 "$sign_in_response"
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
    compose up -d
    status=$?
    set -e
    if ((status == 0)); then
      return 0
    fi

    exit_code=$status
    echo "[comprehensive] Docker bootstrap failed (attempt ${attempt}/${AFFINE_DOCKER_START_RETRIES}, exit ${exit_code})"
    docker_diagnostics
    compose down -v --remove-orphans 2>/dev/null || true

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

compose down -v --remove-orphans 2>/dev/null || true

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
echo "=== Running tool filtering regression ==="
npm run test:tool-filtering

echo ""
echo "=== Running capabilities and fidelity regression ==="
node "$SCRIPT_DIR/test-capabilities-fidelity.mjs"

echo ""
echo "=== Running create-with-placement regression ==="
node "$SCRIPT_DIR/test-create-placement.mjs"

echo ""
echo "=== Running document discovery regression ==="
node "$SCRIPT_DIR/test-doc-discovery.mjs"

echo ""
echo "=== Running find_doc_by_title regression ==="
node "$SCRIPT_DIR/test-find-doc-by-title.mjs"

echo ""
echo "=== Running document custom-property regression ==="
node "$SCRIPT_DIR/test-doc-properties.mjs"

echo ""
echo "=== Running database linked-doc regression ==="
node "$SCRIPT_DIR/test-database-linked-doc.mjs"

echo ""
echo "=== Running read_doc LinkedPage reference regression ==="
node "$SCRIPT_DIR/test-read-doc-linked-refs.mjs"

echo ""
echo "=== Running semantic page composer regression ==="
node "$SCRIPT_DIR/test-semantic-page-composer.mjs"

echo ""
echo "=== Running database intent regression ==="
node "$SCRIPT_DIR/test-database-intent.mjs"

echo ""
echo "=== Running database cells regression ==="
node "$SCRIPT_DIR/test-database-cells.mjs"

echo ""
echo "=== Running native template regression ==="
node "$SCRIPT_DIR/test-native-template-instantiation.mjs"

echo ""
echo "=== Running organize tools regression ==="
node "$SCRIPT_DIR/test-organize-tools.mjs"

echo ""
echo "=== Running supporting tools regression ==="
node "$SCRIPT_DIR/test-supporting-tools.mjs"

echo ""
echo "=== Running comprehensive MCP regression ==="
AFFINE_COMPREHENSIVE_ASSUME_FOCUSED_COVERAGE=true node "$PROJECT_DIR/test-comprehensive.mjs"

echo ""
echo "=== Comprehensive regression completed successfully ==="
