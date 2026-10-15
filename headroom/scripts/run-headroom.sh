#!/usr/bin/env bash
# Installs Headroom (a local compression proxy) into ./.venv and starts it in front of the gateway.
#
#   harness --> Headroom :8787 --> agentgateway :3000 /v1/messages --> Anthropic
#
# Headroom compresses the request body (tool results, history) before it reaches the model.
# It runs on your machine, and prompts are not sent anywhere for compression.
#
# Usage: ./scripts/run-headroom.sh
# Env:   HEADROOM_PORT (8787)        HEADROOM_MODE (token | cache, default token)
#        GATEWAY_URL (http://localhost:3000)   upstream: the gateway's Anthropic route
#        HEADROOM_LOSSLESS=1         lossless compaction instead of lossy compression
#        HEADROOM_EXTRAS (proxy)     pip extras. The reference demo uses "all" (much larger).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${HEADROOM_PORT:-8787}"
MODE="${HEADROOM_MODE:-token}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
EXTRAS="${HEADROOM_EXTRAS:-proxy}"

pick_python() {
  for p in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$p" >/dev/null 2>&1 || continue
    "$p" -c 'import sys,venv,ensurepip; sys.exit(0 if sys.version_info[:2]>=(3,10) else 1)' 2>/dev/null && { command -v "$p"; return; }
  done
  echo "Need Python 3.10 or newer (with venv)." >&2; exit 1
}

if [ ! -x .venv/bin/headroom ]; then
  PY="$(pick_python)"
  echo "Installing headroom-ai[$EXTRAS] into ./.venv with $PY (about a minute) ..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q "headroom-ai[$EXTRAS]"
fi
echo "Headroom $(.venv/bin/headroom --version)"

# The gateway must be up first: Headroom forwards to its /v1/messages.
if ! curl -s -o /dev/null -m 3 "$GATEWAY_URL/v1/models"; then
  echo "Warning: nothing answers at $GATEWAY_URL. Start the gateway first: ./scripts/run-gateway.sh" >&2
fi

# Flags, and why:
#   --mode token      prioritise compression (prior turns may be rewritten for maximum savings)
#   --stateless       no filesystem writes
#   --no-cache        no semantic cache: it can serve a stale answer to near-identical tool-calling requests
#   --no-ccr          no retrieval markers and no injected retrieval tool. The model works through
#                     MCP tools, and an extra injected tool breaks that flow. Compression is lossy.
#   --lossless        (HEADROOM_LOSSLESS=1) compaction that loses nothing, with no markers either
if [ "${HEADROOM_LOSSLESS:-0}" = "1" ]; then CCR_FLAG="--lossless"; else CCR_FLAG="--no-ccr"; fi

mkdir -p logs
echo "Starting Headroom on :$PORT (mode=$MODE $CCR_FLAG), upstream $GATEWAY_URL"
echo "The first start downloads the Kompress model from Hugging Face, so give it a minute."
export ANTHROPIC_TARGET_API_URL="$GATEWAY_URL"
export HEADROOM_BEACON=off
exec .venv/bin/headroom proxy --port "$PORT" --mode "$MODE" --stateless --no-cache "$CCR_FLAG" --log-file logs/headroom-requests.jsonl
