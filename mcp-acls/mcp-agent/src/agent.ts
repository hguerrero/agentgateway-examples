import "dotenv/config";
import { readFileSync } from "node:fs";
import { agent, llmOpenAI, mcp } from "@volcano.dev/agent";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";

// Pick the identity: DEMO_USER=alice (readonly) or bob (readwrite),
// or pass any JWT directly with MCP_BEARER_TOKEN.
const user = process.env.DEMO_USER ?? "alice";
const token =
  process.env.MCP_BEARER_TOKEN ??
  readFileSync(new URL(`../../agentgateway-config/keys/${user}.jwt`, import.meta.url), "utf8").trim();

const llm = llmOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
});

const auth = { type: "bearer" as const, token };
const github = mcp(`${GATEWAY_URL}/mcp/github`, { auth });
const jira = mcp(`${GATEWAY_URL}/mcp/jira`, { auth });

console.log(`Running as ${user}\n`);

const simpleAgent = agent({ llm }).then({
  prompt:
    "List the open pull requests of the repository solo-io/agentgateway, then try to create " +
    "a GitHub issue titled 'ACL demo' in that repository and a Jira issue 'ACL demo' in project DEMO. " +
    "Tell me which tools you were able to use and which ones you could not find.",
  mcps: [github, jira],
});

const result = await simpleAgent.run();

console.log(result[result.length - 1]?.llmOutput || "No output");
