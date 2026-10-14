import "dotenv/config";
import { readFileSync } from "node:fs";
import { agent, llmOpenAI, mcp } from "@volcano.dev/agent";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";

// Pick the identity: DEMO_USER=alice (readonly) or bob (readwrite),
// or pass any JWT directly with MCP_BEARER_TOKEN.
const user = process.env.DEMO_USER ?? "bob";
const token =
  process.env.MCP_BEARER_TOKEN ??
  readFileSync(new URL(`../../agentgateway-config/keys/${user}.jwt`, import.meta.url), "utf8").trim();

const llm = llmOpenAI({
  baseURL: LLM_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
});

const auth = { type: "bearer" as const, token };
const chucknorris = mcp(`${GATEWAY_URL}/mcp/chucknorris`, { auth });
const github = mcp(`${GATEWAY_URL}/mcp/github`, { auth });
const jira = mcp(`${GATEWAY_URL}/mcp/jira`, { auth });

console.log(`Running as ${user}\n`);

const simpleAgent = agent({ llm }).then({
  prompt:
    "tell me 3 random words",
  mcps: [
    chucknorris,
    github, 
    jira
  ],
});

const result = await simpleAgent.run();

console.log(result[result.length - 1]?.llmOutput || "No output");
