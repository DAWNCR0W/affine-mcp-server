#!/usr/bin/env bash
#
# Generate random credentials for E2E tests.
#
# Usage:  source this file from run-e2e.sh (or any shell):
#
#   . tests/generate-test-env.sh
#
# It exports AFFINE_ADMIN_EMAIL, AFFINE_ADMIN_PASSWORD, DB_PASSWORD, etc.
# and writes docker/.env so Docker Compose picks them up.
#
set -euo pipefail

rand_password() {
  # 24-char alphanumeric — safe for JSON bodies and shell quoting.
  # Use a variable to avoid SIGPIPE from piped `head -c 24` under pipefail.
  local raw
  raw="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  printf '%s' "${raw:0:24}"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(cd "$SCRIPT_DIR/../docker" && pwd)"

# Allow overrides from environment; generate if missing.
export AFFINE_ADMIN_EMAIL="${AFFINE_ADMIN_EMAIL:-test@affine.local}"
export AFFINE_ADMIN_PASSWORD="${AFFINE_ADMIN_PASSWORD:-$(rand_password)}"
export DB_USERNAME="${DB_USERNAME:-affine}"
export DB_PASSWORD="${DB_PASSWORD:-$(rand_password)}"
export DB_DATABASE="${DB_DATABASE:-affine}"

# Write docker/.env consumed by docker-compose.yml
cat > "$DOCKER_DIR/.env" <<EOF
AFFINE_REVISION=stable
PORT=3010
DB_USERNAME=$DB_USERNAME
DB_PASSWORD=$DB_PASSWORD
DB_DATABASE=$DB_DATABASE
AFFINE_ADMIN_EMAIL=$AFFINE_ADMIN_EMAIL
AFFINE_ADMIN_PASSWORD=$AFFINE_ADMIN_PASSWORD
EOF

echo "[generate-test-env] Credentials generated → docker/.env"
