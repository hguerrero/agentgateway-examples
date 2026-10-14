# MCP Access Control Lists (ACLs) with agentgateway

This example shows how to use [agentgateway](https://agentgateway.dev) to give AI agents fine-grained access to MCP tools.

Two users hit the same MCP endpoints. The gateway decides which tools each one can see and call:

- **alice** (`readonly`): can list issues, pull requests and branches
- **bob** (`readwrite`): can also create, merge and delete

```
┌─────────────┐   JWT    ┌───────────────────────────┐        ┌──────────────────┐
│   AI Agent  │─────────▶│       agentgateway        │───────▶│  REST backends   │
│ (this app)  │          │  jwtAuth + mcpAuthorization│  HTTP  │ GitHub / Jira    │
└─────────────┘          │  OpenAPI ─▶ MCP tools     │        │ (httpbin stand-in)│
                         └───────────────────────────┘        └──────────────────┘
```

## How it works

| Need | agentgateway feature |
|---|---|
| Turn REST APIs into MCP tools | `mcp` backend with an `openapi` target. Tools come from the OpenAPI spec. |
| Know who is calling | `jwtAuth` policy (`mode: strict`) with a JWKS |
| Put users in groups | `groups` claim in the JWT |
| Default access for a group | catch-all CEL rule: `"readwrite" in jwt.groups` |
| Per-tool access | CEL rule that lists the read tools for both groups |
| One endpoint per service | one route per service (`/mcp/github`, `/mcp/jira`) |

A tool that no rule allows is **hidden from `tools/list`** and **rejected on `tools/call`**. The agent never learns the tool exists.

## Components

```
mcp-acls/
├── agentgateway-config/
│   ├── config.yaml          # routes, JWT auth, tool ACLs
│   └── openapi/             # GitHub and Jira APIs, exposed as MCP tools
├── scripts/
│   ├── gen-keys.mjs         # creates JWKS and one JWT per user
│   └── demo.sh              # alice vs bob with curl, no LLM needed
├── mcp-agent/               # TypeScript agent (Volcano SDK + OpenAI)
└── docker-compose.yaml      # httpbin as a stand-in backend
```

### GitHub tools

| Tool | Access |
|---|---|
| `listIssues`, `listPullRequests`, `listBranches` | readonly and readwrite |
| `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `createBranch`, `deleteBranch` | readwrite |

### Jira tools

| Tool | Access |
|---|---|
| `listIssues`, `searchIssues`, `listProjects` | readonly and readwrite |
| `createIssue`, `updateIssue`, `deleteIssue` | readwrite |

## Getting started

### Prerequisites

- [agentgateway](https://agentgateway.dev/docs/standalone/latest/quickstart/) (tested with v1.6.0)
- Docker (for the httpbin backend)
- Node.js 18+
- `curl` and `jq` (for the demo script)
- OpenAI API key (only for the agent)

### 1. Start the backend

```bash
docker compose up -d
```

The OpenAPI specs point at `localhost:8080`. httpbin echoes every request on `/anything/*`, so you can see what the gateway forwarded without touching a real GitHub or Jira.

### 2. Create keys and tokens

```bash
node scripts/gen-keys.mjs
```

This writes `agentgateway-config/keys/jwks.json` plus `alice.jwt` and `bob.jwt`. The tokens last 7 days. Run the script again to renew them.

### 3. Start agentgateway

```bash
cd agentgateway-config
agentgateway -f config.yaml
```

Run it from `agentgateway-config/`, because the config uses relative paths for the JWKS and the OpenAPI files. To check the file without starting the gateway:

```bash
agentgateway -f config.yaml --validate-only
```

### 4. See the ACLs with curl

```bash
./scripts/demo.sh github     # or: ./scripts/demo.sh jira
```

Expected result for `github`:

```
=============== alice (groups: readonly) ===============
--- tools/list
  github_listIssues
  github_listPullRequests
  github_listBranches
--- tools/call github_listIssues     -> HTTP 200
--- tools/call github_createIssue    -> "Unknown tool: github_createIssue"

=============== bob (groups: readwrite) ===============
--- tools/list
  github_listIssues ... github_deleteBranch   (all 9 tools)
--- tools/call github_listIssues     -> HTTP 200
--- tools/call github_createIssue    -> HTTP 200

=============== no token ===============
tools/list without Authorization -> HTTP 401
```

### 5. Run the agent

```bash
cd mcp-agent
npm install
cp .env.example .env     # set OPENAI_API_KEY
DEMO_USER=alice npm run dev
DEMO_USER=bob   npm run dev
```

Same prompt, same code, two identities. As alice, the agent can list pull requests but reports that it has no tool to create issues. As bob, it creates them.

You can also point any MCP client at the gateway, for example the MCP Inspector, with `Authorization: Bearer $(cat agentgateway-config/keys/alice.jwt)`:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3000/mcp/github
```

## ACL configuration

### Authentication

```yaml
jwtAuth:
  mode: strict              # no valid token, no access (HTTP 401)
  issuer: mcp-acls-demo
  audiences: [agentgateway-mcp]
  jwks:
    file: ./keys/jwks.json
```

### Authorization

`mcpAuthorization` is an allow-list of [CEL](https://agentgateway.dev/docs/standalone/latest/reference/cel/) expressions. A request passes when any rule is true. The rules can use `mcp.tool.name`, `mcp.tool.target` and any JWT claim.

```yaml
mcpAuthorization:
  rules:
    # per-tool ACL: read tools for both groups
    - allow: |
        (mcp.tool.name == "listIssues" ||
         mcp.tool.name == "listPullRequests" ||
         mcp.tool.name == "listBranches") &&
        has(jwt.groups) &&
        ("readonly" in jwt.groups || "readwrite" in jwt.groups)
    # default ACL: readwrite can use everything
    - allow: |
        has(jwt.groups) && "readwrite" in jwt.groups
```

Things to know:

- Rules match the OpenAPI `operationId` (`listIssues`). Clients see the prefixed name (`github_listIssues`) because of `prefixMode: always`.
- Rules run before tool arguments are parsed, so you can allow or deny by tool, but not by argument value.
- Authorization is evaluated per route, so GitHub and Jira can have different rules.

## Customization

### Add a tool

Add the operation to `agentgateway-config/openapi/<service>.yaml`. It is `readwrite` only by default. To open it to `readonly`, add its `operationId` to the first rule in `config.yaml`.

### Use real backends

Change `host` in the target (and the `servers` entry in the OpenAPI file) to your GitHub or Jira gateway, and add `backendAuth` if the upstream needs credentials.

### Use your identity provider

Replace the `jwks.file` with `jwks.url`, set `issuer` and `audiences` to match your IdP, and map your group or role claim in the CEL rules. For OAuth flows with MCP clients, see the `mcpAuthentication` policy.

### Add a third service

Add a route (for example `/mcp/public`) with no `jwtAuth` and no `mcpAuthorization`. Its tools are open to everyone.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401 Unauthorized` | Token missing, expired, or wrong `iss` / `aud`. Run `node scripts/gen-keys.mjs` again. Keys and tokens must come from the same run. |
| Tool missing from `tools/list` | No rule allows it for this token's `groups`. |
| `Unknown tool` on `tools/call` | Same cause. Denied tools are indistinguishable from tools that don't exist. |
| Tool shows up but call returns an error | Arguments must be grouped by location: `{"query": {...}}`, `{"path": {...}}`, `{"body": {...}}`. Read the tool's `inputSchema`. |
| `connection refused` on tool calls | httpbin is not running (`docker compose up -d`). |
| Cannot find `./keys/jwks.json` | Start the gateway from `agentgateway-config/`. |

## Related documentation

- [agentgateway MCP authorization](https://agentgateway.dev/docs/standalone/latest/mcp/mcp-authz/)
- [Connect to an OpenAPI server](https://agentgateway.dev/docs/standalone/latest/mcp/connect/openapi/)
- [Model Context Protocol specification](https://modelcontextprotocol.io/)
