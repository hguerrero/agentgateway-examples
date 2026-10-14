# MCP proxy with agentgateway

This example shows how [agentgateway](https://agentgateway.dev) works as an MCP proxy. One gateway gives AI agents two things:

1. **REST API to MCP conversion.** An existing REST API becomes a set of MCP tools, described by its OpenAPI spec. The API does not change.
2. **MCP server passthrough.** An existing MCP server is proxied as is. The gateway handles sessions and logs every MCP call.

## Architecture

```
AI agent
    ↓
agentgateway (localhost:3000)
    ↓
├── /api/chucknorris  → https://api.chucknorris.io           (plain REST proxy)
├── /mcp/chucknorris  → https://api.chucknorris.io           (REST converted to MCP tools)
└── /mcp/everything   → http://localhost:3001/mcp            (MCP server, passthrough)
```

## Components

```
mcp-proxy/
├── agentgateway-config/
│   ├── config.yaml      # the three routes
│   └── openapi.yaml     # tool definitions for the Chuck Norris API
└── scripts/
    └── demo.sh          # calls all three routes with curl, no LLM needed
```

## Configuration

`agentgateway-config/config.yaml` has one route for each pattern.

### REST proxy (`/api/chucknorris`)

A plain HTTP route to the upstream API. It strips the `/api/chucknorris` prefix, sets the `Host` header, and uses TLS to the backend. You can call the API directly through the gateway:

```yaml
- name: chucknorris-api
  matches:
    - path:
        pathPrefix: /api/chucknorris
  policies:
    urlRewrite:
      authority:
        host: api.chucknorris.io
      path:
        prefix: ""
    backendTLS: {}
  backends:
    - host: api.chucknorris.io:443
```

### REST to MCP conversion (`/mcp/chucknorris`)

An `mcp` backend with an `openapi` target. Every operation in the spec becomes a tool, named after its `operationId`:

```yaml
- name: chucknorris-mcp
  matches:
    - path:
        pathPrefix: /mcp/chucknorris
  backends:
    - mcp:
        statefulMode: stateless
        targets:
          - name: chucknorris
            openapi:
              schema:
                file: ./openapi.yaml
              host: https://api.chucknorris.io
```

| OpenAPI operation | MCP tool |
|---|---|
| `GET /random` (`getJoke`) | `getJoke` |
| `GET /categories` (`getCategoriesList`) | `getCategoriesList` |
| `GET /search` (`getJokesWithString`) | `getJokesWithString` |

Tool descriptions and parameters come from the spec, so a better spec gives the agent better tools. Arguments are grouped by where they go in the HTTP request, for example `{"query": {"category": "dev"}}`.

### MCP passthrough (`/mcp/everything`)

An `mcp` backend with an `mcp` target. The gateway forwards the MCP protocol to the upstream server and does not need a tool definition:

```yaml
- name: everything-mcp
  matches:
    - path:
        pathPrefix: /mcp/everything
  backends:
    - mcp:
        targets:
          - name: everything
            mcp:
              host: http://localhost:3001/mcp
```

The demo uses the MCP "everything" test server, because it runs locally and needs no account. To proxy a remote server instead, change `host` to its URL, for example `https://servereverything.dev/mcp`.

## Getting started

### Prerequisites

- [agentgateway](https://agentgateway.dev/docs/standalone/latest/quickstart/) (tested with v1.6.0)
- Node.js 18+ (to run the MCP "everything" server with `npx`)
- `curl` and `jq`
- Internet access to `api.chucknorris.io`

### 1. Start the MCP server

In a terminal:

```bash
PORT=3001 npx -y @modelcontextprotocol/server-everything streamableHttp
```

### 2. Start agentgateway

In another terminal:

```bash
cd agentgateway-config
agentgateway -f config.yaml
```

Run it from `agentgateway-config/`, because the config uses a relative path for the OpenAPI file. To check the file without starting the gateway:

```bash
agentgateway -f config.yaml --validate-only
```

### 3. Run the demo

```bash
./scripts/demo.sh
```

Expected result:

```
=============== 1. REST through the proxy: GET /api/chucknorris/jokes/random?category=dev
Chuck Norris's beard can type 140 wpm.

=============== 2. REST converted to MCP: /mcp/chucknorris
--- tools/list
  getJoke: Retrieve a random Chuck Norris joke in JSON format.
  getCategoriesList: Retrieve the list of available joke categories.
  getJokesWithString: Retrieve jokes that contain the given string.
--- tools/call getJoke (category=dev)
  Chuck Norris doesn't needs try-catch, exceptions are too afraid to raise.

=============== 3. MCP passthrough: /mcp/everything
--- tools/list (first 5)
  echo
  get-annotated-message
  ...
--- tools/call echo
  Echo: hello through agentgateway
```

The jokes change on every run.

### Use your own MCP client

Point any MCP client at `http://localhost:3000/mcp/chucknorris` or `http://localhost:3000/mcp/everything` (transport: Streamable HTTP). For example, with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

The `mcp-acls` example in this repo has a TypeScript agent that you can point at these URLs.

## Logs and debugging

agentgateway logs every request on stdout, with the MCP method and tool name:

```
info request route=default/everything-mcp http.method=POST http.path=/mcp/everything http.status=200 protocol=mcp mcp.method.name=tools/call mcp.target=everything gen_ai.tool.name=echo duration=2ms
```

Useful checks:

```bash
# validate the config without starting the gateway
agentgateway -f config.yaml --validate-only

# open the admin UI (default: http://localhost:15000/ui) to see routes, backends, and a tool playground
```

## Use cases

1. **Legacy API integration.** Expose existing REST APIs to AI agents without changing them.
2. **API aggregation.** Add several targets to one `mcp` backend to give agents a single endpoint. Tools are prefixed with the target name.
3. **MCP gateway.** Put one endpoint, with auth and logging, in front of your MCP servers.
4. **Tool discovery.** Give agents one catalog of tools.

## Customization

### Add a tool

Add the operation to `agentgateway-config/openapi.yaml`. Restart the gateway if it does not pick up the change.

### Add a target to a route

Add another entry to `targets`. With more than one target, clients see tool names prefixed with the target name (for example `chucknorris_getJoke`).

### Secure the routes

This example has no authentication. The `mcp-acls` example in this repo adds JWT authentication and tool-level access control to the same kind of routes.

## Troubleshooting

| Symptom | Check |
|---|---|
| `route not found` | The path does not match a route. Check the prefix in `config.yaml`. |
| `Address already in use` at startup | Another gateway is running on port 3000 (or on the admin ports 15000, 15020, 15021). Stop it first. |
| Step 3 of the demo fails with `no Mcp-Session-Id` | The MCP "everything" server is not running on port 3001. |
| Tool call returns an error | Arguments must be grouped by location: `{"query": {...}}`, `{"path": {...}}`, `{"body": {...}}`. Read the tool's `inputSchema`. |

## Resources

- [agentgateway: connect to an OpenAPI server](https://agentgateway.dev/docs/standalone/latest/mcp/connect/openapi/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Chuck Norris API](https://api.chucknorris.io/)
