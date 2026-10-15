#!/usr/bin/env bash
# Starts Solo Enterprise agentgateway (standalone) with this example's config.
#
#   export AGENTGATEWAY_LICENSE_KEY=...   (or ENTERPRISE_AGENTGATEWAY_LICENSE_KEY)
#   export ANTHROPIC_API_KEY=...
#   export GITHUB_PAT=...                 (read-only, see README)
#   ./scripts/run-gateway.sh
#
# Install the Enterprise binary first: curl -fsSL https://run.solo.io/agentgateway/install | sh
set -euo pipefail
cd "$(dirname "$0")/../agentgateway-config"

BIN="${AGENTGATEWAY_BIN:-}"
if [ -z "$BIN" ]; then
  if [ -x "$HOME/.agentgateway/bin/agentgateway" ]; then BIN="$HOME/.agentgateway/bin/agentgateway"; else BIN="$(command -v agentgateway || true)"; fi
fi
[ -n "$BIN" ] || { echo "agentgateway not found. Install it: curl -fsSL https://run.solo.io/agentgateway/install | sh" >&2; exit 1; }

# Enterprise versions look like v2026.10.0. The open-source proxy (1.x) ignores toolMode.
VERSION="$("$BIN" --version | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)"
case "$VERSION" in
  v20[0-9][0-9].*) ;;
  *) echo "$BIN is version '$VERSION', which is not the Solo Enterprise build. toolMode needs Enterprise." >&2
     echo "Install it with: curl -fsSL https://run.solo.io/agentgateway/install | sh   (or set AGENTGATEWAY_BIN)" >&2
     exit 1 ;;
esac

export ENTERPRISE_AGENTGATEWAY_LICENSE_KEY="${ENTERPRISE_AGENTGATEWAY_LICENSE_KEY:-${AGENTGATEWAY_LICENSE_KEY:-}}"
[ -n "$ENTERPRISE_AGENTGATEWAY_LICENSE_KEY" ] || { echo "Set AGENTGATEWAY_LICENSE_KEY (or ENTERPRISE_AGENTGATEWAY_LICENSE_KEY)." >&2; exit 1; }
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "Set ANTHROPIC_API_KEY (the gateway sends the model calls to Anthropic)." >&2; exit 1; }
[ -n "${GITHUB_PAT:-}" ] || { echo "Set GITHUB_PAT (a read-only GitHub token, see README)." >&2; exit 1; }

echo "Starting $BIN $VERSION on :3000 (admin UI: http://localhost:15000/ui)"
exec "$BIN" -f config.yaml
