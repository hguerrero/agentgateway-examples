#!/usr/bin/env bash
# Calls the three routes through the gateway, no LLM needed.
#   1. /api/chucknorris  plain REST through the proxy
#   2. /mcp/chucknorris  the same REST API as MCP tools (OpenAPI target)
#   3. /mcp/everything   an existing MCP server, proxied as is (MCP target)
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:3000}"
ACCEPT='application/json, text/event-stream'

# Print the JSON-RPC message from a JSON or SSE response body.
body() { sed -e 's/^data: //' | grep '^{' | head -1; }

rpc() { # path method params [extra curl args]
  local path=$1 method=$2 params=$3; shift 3
  curl -sS -X POST "$GATEWAY$path" -H 'Content-Type: application/json' -H "Accept: $ACCEPT" "$@" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" | body
}

echo "=============== 1. REST through the proxy: GET /api/chucknorris/jokes/random?category=dev"
curl -sS "$GATEWAY/api/chucknorris/jokes/random?category=dev" | jq -r '.value'

echo
echo "=============== 2. REST converted to MCP: /mcp/chucknorris"
echo "--- tools/list"
rpc /mcp/chucknorris tools/list '{}' | jq -r '.result.tools[] | "  \(.name): \(.description)"'
echo "--- tools/call getJoke (category=dev)"
rpc /mcp/chucknorris tools/call '{"name":"getJoke","arguments":{"query":{"category":"dev"}}}' \
  | jq -r '.result.content[0].text | fromjson | "  " + .value'

echo
echo "=============== 3. MCP passthrough: /mcp/everything"
# This backend keeps sessions, so run the MCP handshake first.
headers=$(mktemp); trap 'rm -f "$headers"' EXIT
curl -sS -D "$headers" -o /dev/null -X POST "$GATEWAY/mcp/everything" \
  -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}'
session=$(awk 'tolower($1)=="mcp-session-id:" {print $2}' "$headers" | tr -d '\r')
[ -n "$session" ] || { echo "no Mcp-Session-Id returned; is the MCP server running on :3001?" >&2; exit 1; }
curl -sS -o /dev/null -X POST "$GATEWAY/mcp/everything" -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -H "Mcp-Session-Id: $session" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

echo "--- tools/list (first 5)"
rpc /mcp/everything tools/list '{}' -H "Mcp-Session-Id: $session" | jq -r '[.result.tools[].name][:5][] | "  " + .'
echo "--- tools/call echo"
rpc /mcp/everything tools/call '{"name":"echo","arguments":{"message":"hello through agentgateway"}}' \
  -H "Mcp-Session-Id: $session" | jq -r '"  " + .result.content[0].text'
