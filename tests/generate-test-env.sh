#!/usr/bin/env bash
#
# Generate random credentials for E2E tests.
#
# Usage:  source this file from run-e2e.sh (or any shell):
#
#   . tests/generate-test-env.sh
#
# It exports AFFINE_ADMIN_EMAIL, AFFINE_ADMIN_PASSWORD, DB_PASSWORD, etc.
# and writes a private, per-run env file. Pass AFFINE_TEST_ENV_FILE to
# `docker compose --env-file` rather than sharing docker/.env between runs.
#
set -euo pipefail

rand_password() {
  # 24-char alphanumeric — safe for JSON bodies and shell quoting.
  # Use a variable to avoid SIGPIPE from piped `head -c 24` under pipefail.
  local raw
  raw="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  printf '%s' "${raw:0:24}"
}

dotenv_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\$/\$\$}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf '"%s"' "$value"
}

# Allow overrides from environment; generate if missing.
export AFFINE_ADMIN_EMAIL="${AFFINE_ADMIN_EMAIL:-test@affine.local}"
export AFFINE_ADMIN_PASSWORD="${AFFINE_ADMIN_PASSWORD:-$(rand_password)}"
export DB_USERNAME="${DB_USERNAME:-affine}"
export DB_PASSWORD="${DB_PASSWORD:-$(rand_password)}"
export DB_DATABASE="${DB_DATABASE:-affine}"
export AFFINE_REVISION="${AFFINE_REVISION:-stable}"
export PORT="${PORT:-3010}"

if [[ -z "${AFFINE_TEST_ENV_FILE:-}" ]]; then
  temp_root="${TMPDIR:-/tmp}"
  temp_root="${temp_root%/}"
  AFFINE_TEST_ENV_FILE="$(mktemp "${temp_root}/affine-mcp-test-env.XXXXXX")"
  AFFINE_TEST_ENV_FILE_OWNED=1
else
  if [[ -e "$AFFINE_TEST_ENV_FILE" && "${AFFINE_OVERWRITE_TEST_ENV_FILE:-0}" != "1" ]]; then
    requested_env_file="$AFFINE_TEST_ENV_FILE"
    temp_root="${TMPDIR:-/tmp}"
    temp_root="${temp_root%/}"
    AFFINE_TEST_ENV_FILE="$(mktemp "${temp_root}/affine-mcp-test-env.XXXXXX")"
    AFFINE_TEST_ENV_FILE_OWNED=1
    echo "[generate-test-env] Existing file was not overwritten: $requested_env_file" >&2
    echo "[generate-test-env] Using private file instead: $AFFINE_TEST_ENV_FILE" >&2
  else
    AFFINE_TEST_ENV_FILE_OWNED=0
  fi
fi

if [[ "$AFFINE_TEST_ENV_FILE_OWNED" == "1" ]]; then
  env_file_tmp="$AFFINE_TEST_ENV_FILE"
else
  env_file_tmp="$(mktemp "${AFFINE_TEST_ENV_FILE}.tmp.XXXXXX")"
fi
{
  printf 'AFFINE_REVISION=%s\n' "$(dotenv_quote "$AFFINE_REVISION")"
  printf 'PORT=%s\n' "$(dotenv_quote "$PORT")"
  printf 'DB_USERNAME=%s\n' "$(dotenv_quote "$DB_USERNAME")"
  printf 'DB_PASSWORD=%s\n' "$(dotenv_quote "$DB_PASSWORD")"
  printf 'DB_DATABASE=%s\n' "$(dotenv_quote "$DB_DATABASE")"
  printf 'AFFINE_ADMIN_EMAIL=%s\n' "$(dotenv_quote "$AFFINE_ADMIN_EMAIL")"
  printf 'AFFINE_ADMIN_PASSWORD=%s\n' "$(dotenv_quote "$AFFINE_ADMIN_PASSWORD")"
} >"$env_file_tmp"
chmod 600 "$env_file_tmp"
if [[ "$env_file_tmp" != "$AFFINE_TEST_ENV_FILE" ]]; then
  mv -f "$env_file_tmp" "$AFFINE_TEST_ENV_FILE"
fi

export AFFINE_TEST_ENV_FILE AFFINE_TEST_ENV_FILE_OWNED
echo "[generate-test-env] Private credentials written to $AFFINE_TEST_ENV_FILE"
