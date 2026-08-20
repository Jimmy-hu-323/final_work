#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export QWENPAW_WORKING_DIR="$PWD/.qwenpaw"
export QWENPAW_TELEMETRY_ENABLED=false
exec .venv/bin/qwenpaw app \
  --host "${QWENPAW_HOST:-127.0.0.1}" \
  --port "${QWENPAW_PORT:-18088}"
