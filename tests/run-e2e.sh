#!/usr/bin/env bash
#
# E2E test orchestration:
#   1. Start AFFiNE via Docker Compose
#   2. Wait for health + acquire credentials
#   3. Build the MCP server
#   4. Run MCP database creation test (email/password auth)
#   5. Run MCP bearer token auth test
#   6. Run Playwright UI verification (both auth modes)
#   7. Tear down Docker (on exit)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKER_DIR="$PROJECT_DIR/docker"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"

# --- Configuration ---
export AFFINE_BASE_URL="${AFFINE_BASE_URL:-http://localhost:3010}"

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

# --- Step 0: Clean up any stale containers from previous runs ---
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true

# --- Step 1: Start Docker ---
echo "=== Starting AFFiNE via Docker Compose ==="
docker compose -f "$COMPOSE_FILE" up -d

# --- Step 2: Wait for health + verify credentials ---
echo ""
echo "=== Waiting for AFFiNE to become healthy ==="
node "$SCRIPT_DIR/acquire-credentials.mjs"

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

# --- Step 6: Run Playwright verification ---
echo ""
echo "=== Running Playwright UI verification ==="
npx playwright test --config "$SCRIPT_DIR/playwright/playwright.config.ts"

echo ""
echo "=== E2E test pipeline completed successfully ==="
