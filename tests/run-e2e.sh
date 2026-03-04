#!/usr/bin/env bash
#
# E2E test orchestration:
#   1. Start AFFiNE via Docker Compose
#   2. Wait for health + acquire credentials
#   3. Build the MCP server
#   4. Run MCP database creation test (email/password auth)
#   5. Run MCP bearer token auth test
#   6. Run MCP tag visibility setup test
#   7. Run Playwright UI verification (all scenarios)
#   8. Tear down Docker (on exit)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKER_DIR="$PROJECT_DIR/docker"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"

# --- Configuration ---
export AFFINE_BASE_URL="${AFFINE_BASE_URL:-http://localhost:3010}"
export AFFINE_HEALTH_MAX_RETRIES="${AFFINE_HEALTH_MAX_RETRIES:-90}"
export AFFINE_HEALTH_INTERVAL_MS="${AFFINE_HEALTH_INTERVAL_MS:-5000}"
export AFFINE_CREDENTIAL_ACQUIRE_RETRIES="${AFFINE_CREDENTIAL_ACQUIRE_RETRIES:-3}"
export AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS="${AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS:-5}"

# Generate random credentials (writes docker/.env, exports env vars)
echo "=== Generating test credentials ==="
# shellcheck source=generate-test-env.sh
. "$SCRIPT_DIR/generate-test-env.sh"

# --- Cleanup on exit ---
cleanup() {
  echo ""
  echo "=== Tearing down Docker containers ==="
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

docker_diagnostics() {
  echo ""
  echo "=== Docker diagnostics (on failure) ==="
  docker compose -f "$COMPOSE_FILE" ps || true
  echo ""
  docker compose -f "$COMPOSE_FILE" logs --no-color --tail=200 affine affine_migration postgres redis || true
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

# --- Step 0: Clean up any stale containers from previous runs ---
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true

# --- Step 1: Start Docker ---
echo "=== Starting AFFiNE via Docker Compose ==="
docker compose -f "$COMPOSE_FILE" up -d

# --- Step 2: Wait for health + verify credentials ---
echo ""
echo "=== Waiting for AFFiNE to become healthy ==="
acquire_credentials_with_retry

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

# --- Step 6: Run MCP tag visibility setup test ---
echo ""
echo "=== Running MCP tag visibility setup test ==="
node "$SCRIPT_DIR/test-tag-visibility.mjs"

# --- Step 7: Run Playwright verification ---
echo ""
echo "=== Running Playwright UI verification ==="
npx playwright test --config "$SCRIPT_DIR/playwright/playwright.config.ts"

echo ""
echo "=== E2E test pipeline completed successfully ==="
