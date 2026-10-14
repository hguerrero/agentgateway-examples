#!/usr/bin/env bash
# Shows the ACLs in action without an LLM: same endpoint, two identities.
#   alice (readonly)  -> sees and can call only the read tools
#   bob   (readwrite) -> sees and can call everything
set -euo pipefail

cd "$(dirname "$0")/.."
GATEWAY="${GATEWAY:-http://localhost:3000}"
KEYS=agentgateway-config/keys
SERVER="${1:-github}"     # github | jira

case "$SERVER" in
  github) READ_TOOL=github_listIssues;  READ_ARGS='{"query":{"repository":"solo-io/agentgateway"}}'
          WRITE_TOOL=github_createIssue; WRITE_ARGS='{"query":{"repository":"solo-io/agentgateway","title":"hello from the demo"}}' ;;
  jira)   READ_TOOL=jira_listProjects;  READ_ARGS='{}'
          WRITE_TOOL=jira_createIssue;  WRITE_ARGS='{"query":{"project":"DEMO","summary":"hello from the demo"}}' ;;
  *) echo "usage: $0 [github|jira]" >&2; exit 1 ;;
esac

# Tool arguments are grouped by OpenAPI location: {"query":{...}}, {"path":{...}}, {"body":{...}}.
# MCP over streamable HTTP; the gateway runs in stateless mode so no session handshake is needed.
rpc() { # token method params
  curl -sS -X POST "$GATEWAY/mcp/$SERVER" \
    -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" \
    -w '\n[HTTP %{http_code}]\n' | sed -e 's/^data: //' | grep -v '^event:' | grep -v '^$'
}

tool_names() { jq -r '.result.tools[].name' 2>/dev/null || true; }

for user in alice bob; do
  token=$(cat "$KEYS/$user.jwt")
  groups=$(jq -rR 'split(".")[1] | @base64d | fromjson | .groups | join(",")' "$KEYS/$user.jwt")
  echo
  echo "=============== $user (groups: $groups) ==============="

  echo "--- tools/list"
  rpc "$token" tools/list '{}' | grep -v '^\[HTTP' | tool_names | sed 's/^/  /'

  echo "--- tools/call $READ_TOOL"
  rpc "$token" tools/call "{\"name\":\"$READ_TOOL\",\"arguments\":$READ_ARGS}" | cut -c1-200

  echo "--- tools/call $WRITE_TOOL"
  rpc "$token" tools/call "{\"name\":\"$WRITE_TOOL\",\"arguments\":$WRITE_ARGS}" | cut -c1-200
done

echo
echo "=============== no token ==============="
curl -sS -o /dev/null -w "tools/list without Authorization -> HTTP %{http_code}\n" -X POST "$GATEWAY/mcp/$SERVER" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
