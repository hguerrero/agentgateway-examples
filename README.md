# agentgateway examples

Worked examples for [agentgateway](https://agentgateway.dev). Each example is self-contained and comes with the configuration, scripts, and commands to run it.

## Examples

| Example | What it shows | Tested with |
| :--- | :--- | :--- |
| [`mcp-proxy`](mcp-proxy/) | How agentgateway works as an MCP proxy. A REST API (Chuck Norris jokes) is converted to MCP tools from an OpenAPI spec, and an existing MCP server is proxied as is. Includes a curl demo | agentgateway v1.6.0 |
| [`mcp-toolmodes`](mcp-toolmodes/) | The four MCP tool modes of Solo Enterprise agentgateway (standalone): `standard`, `search` (`get_tool` + `invoke_tool`), `code` (`run_code`) and `codeSearch` (`get_tool` + `run_code`), side by side on GitHub's 28-tool MCP server. A harness compares tokens and cost per mode (-46% for search and -37% for code in the measured runs) | Enterprise v2026.10.0 |
| [`headroom`](headroom/) | Tool modes plus Headroom (a local compression proxy), standalone. Runs GitHub questions through standard, search and code mode with Headroom off and on, on a small and a large repository, and scores answer quality with an LLM judge. Finding: the savings mostly did not stack, and lossy compression dropped items from big lists | Enterprise v2026.10.0, Headroom 0.40.0 |
| [`mcp-acls`](mcp-acls/) | Tool-level access control for MCP. REST APIs (GitHub and Jira stand-ins) are exposed as MCP tools from OpenAPI specs, callers authenticate with JWTs, and CEL rules decide which tools each group (`readonly`, `readwrite`) can see and call. Includes a curl demo and a TypeScript agent | agentgateway v1.6.0 |

## How the examples are organized

- Each example lives in its own folder with its own `README.md`, and you can run it without the rest of the repo.
- Each README lists its prerequisites and the versions it was tested with. agentgateway changes often, so versions are pinned per example and not for the whole repo. Check the [agentgateway docs](https://agentgateway.dev/docs/) for current ones.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
