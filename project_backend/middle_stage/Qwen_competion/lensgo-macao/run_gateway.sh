#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec .venv/bin/uvicorn gateway.app:app \
  --host "${GATEWAY_HOST:-0.0.0.0}" \
  --port "${GATEWAY_PORT:-8000}"
