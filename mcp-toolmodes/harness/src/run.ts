import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, writeFileSync } from "node:fs";

// Runs the same GitHub questions against one MCP route per tool mode (standard, search, code, codeSearch)
// and compares token use, cost and round trips.
// The model calls and the MCP calls both go through agentgateway.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const MODEL = process.env.MODEL ?? "claude-opus-5-5";
const MODES = (process.env.MODES ?? "standard,search,code,codeSearch").split(",").map((m) => m.trim());
const REPO = process.env.REPO ?? "agentgateway/agentgateway";
const ONLY = process.env.QUESTIONS?.split(",").map((n) => Number(n));
const MAX_TURNS = 14;
const MAX_RESULT_CHARS = 60_000; // safety net for a runaway tool result; the report says if it is hit

// USD per million tokens. Override with PRICE_INPUT / PRICE_OUTPUT for other models.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const price = {
  ...(PRICES[MODEL] ?? { input: NaN, output: NaN, cacheRead: 0, cacheWrite: 0 }),
  ...(process.env.PRICE_INPUT ? { input: Number(process.env.PRICE_INPUT) } : {}),
  ...(process.env.PRICE_OUTPUT ? { output: Number(process.env.PRICE_OUTPUT) } : {}),
};

// What each mode must expose. If it does not, the gateway is not the Enterprise build (the open-source
// proxy ignores toolMode and serves every tool) or the license did not load.
const EXPECTED: Record<string, (names: string[]) => boolean> = {
  standard: (n) => n.length > 2 && !n.includes("run_code") && !n.includes("get_tool"),
  search: (n) => n.length === 2 && n.includes("get_tool") && n.includes("invoke_tool"),
  code: (n) => n.length === 1 && n[0] === "run_code",
  codeSearch: (n) => n.length === 2 && n.includes("get_tool") && n.includes("run_code"),
};

const QUESTIONS = [
  { id: 1, text: "What is the latest release of the repository, and when was it published?" },
  { id: 2, text: "Who authored the 5 most recent commits on the default branch? List each author with the commit subject." },
  { id: 3, text: "Look at the 5 most recently closed pull requests. Which of them changed the most files? Give its number, title and file count." },
  { id: 4, text: "How many open pull requests does the repository have, and who opened the 3 most recently updated ones?" },
].filter((q) => !ONLY || ONLY.includes(q.id));

const SYSTEM =
  `You answer questions about the GitHub repository ${REPO} using the tools you have. ` +
  `Only query this repository. Keep list requests small (per_page of 5 or fewer unless you need more). ` +
  `Answer in a few lines.`;

// The model calls go through agentgateway, which holds the API key.
const anthropic = new Anthropic({ baseURL: GATEWAY_URL, apiKey: "set-by-the-gateway" });

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type QResult = { id: number; modelCalls: number; toolCalls: number; usage: Usage; usd: number; truncated: boolean; answer: string };
type ModeResult = { mode: string; tools: string[]; catalogTokens: number | null; questions: QResult[] };

const usd = (u: Usage) =>
  (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1e6;
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);

async function catalogTokens(tools: Anthropic.Tool[]): Promise<number | null> {
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];
    const [withTools, without] = await Promise.all([
      anthropic.messages.countTokens({ model: MODEL, tools, messages }),
      anthropic.messages.countTokens({ model: MODEL, messages }),
    ]);
    return withTools.input_tokens - without.input_tokens;
  } catch {
    return null;
  }
}

async function runMode(mode: string): Promise<ModeResult> {
  const mcp = new Client({ name: "tool-modes-harness", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${GATEWAY_URL}/mcp/${mode}`)));

  const listed = (await mcp.listTools()).tools;
  const names = listed.map((t) => t.name);
  const check = EXPECTED[mode];
  if (!check) throw new Error(`unknown mode "${mode}"`);
  if (!check(names)) {
    throw new Error(
      `/mcp/${mode} exposes ${names.length} tool(s) (${names.slice(0, 4).join(", ")}...), not what toolMode "${mode}" should expose. ` +
        `Is this the Solo Enterprise build with a valid license? The open-source proxy always runs in standard mode.`,
    );
  }
  const tools: Anthropic.Tool[] = listed.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  const catalog = await catalogTokens(tools);
  console.log(`\n=== ${mode}: ${names.length} tool(s) exposed [${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}], catalog ~${catalog ?? "n/a"} tokens`);

  const questions: QResult[] = [];
  for (const q of QUESTIONS) {
    const r: QResult = { id: q.id, modelCalls: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0, truncated: false, answer: "" };
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: q.text }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        output_config: { effort: "low" },
        system: SYSTEM,
        tools,
        messages,
      });
      r.modelCalls++;
      r.usage.input += response.usage.input_tokens;
      r.usage.output += response.usage.output_tokens;
      r.usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      r.usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "text") r.answer = block.text;
        if (block.type !== "tool_use") continue;
        r.toolCalls++;
        // A failed call (bad arguments, upstream error) goes back to the model as an error result, so it can retry.
        let text: string;
        let isError = false;
        try {
          const result = await mcp.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
          text = (result.content as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
          isError = result.isError === true;
        } catch (e) {
          text = e instanceof Error ? e.message : String(e);
          isError = true;
        }
        if (text.length > MAX_RESULT_CHARS) {
          r.truncated = true;
          text = `${text.slice(0, MAX_RESULT_CHARS)}\n... (truncated, ${text.length} chars)`;
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "tool_use") messages.push({ role: "user", content: results });
      else if (response.stop_reason !== "pause_turn") break;
    }
    r.usd = usd(r.usage);
    questions.push(r);
    console.log(`  Q${q.id}: ${r.modelCalls} model calls, ${r.toolCalls} tool calls, ${r.usage.input} in / ${r.usage.output} out tokens, $${r.usd.toFixed(4)}${r.truncated ? " (a result was truncated)" : ""}`);
  }
  await mcp.close();
  return { mode, tools: names, catalogTokens: catalog, questions };
}

const results: ModeResult[] = [];
for (const m of MODES) results.push(await runMode(m));

// ---- report
const total = (m: ModeResult) => ({
  modelCalls: sum(m.questions, (q) => q.modelCalls),
  toolCalls: sum(m.questions, (q) => q.toolCalls),
  input: sum(m.questions, (q) => q.usage.input + q.usage.cacheRead + q.usage.cacheWrite),
  output: sum(m.questions, (q) => q.usage.output),
  usd: sum(m.questions, (q) => q.usd),
});
const base = results.find((m) => m.mode === "standard");
const pct = (a: number, b: number) => (b ? `${a <= b ? "-" : "+"}${Math.abs(Math.round(((a - b) / b) * 100))}%` : "");
const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(4)}` : "n/a");

console.log(`\nModel: ${MODEL}   Repo: ${REPO}   Questions: ${QUESTIONS.map((q) => q.id).join(", ")}`);
console.log("\nmode        tools  catalog tok  model calls  tool calls  input tok  output tok       cost   vs standard");
for (const m of results) {
  const t = total(m);
  console.log(
    `${m.mode.padEnd(11)} ${String(m.tools.length).padStart(5)}  ${String(m.catalogTokens ?? "n/a").padStart(11)}  ${String(t.modelCalls).padStart(11)}  ${String(t.toolCalls).padStart(10)}  ${String(t.input).padStart(9)}  ${String(t.output).padStart(10)}  ${money(t.usd).padStart(9)}   ${base && m !== base ? pct(t.usd, total(base).usd) : ""}`,
  );
}
console.log("\ncost per question");
console.log(`Q   ${results.map((m) => m.mode.padStart(12)).join("")}`);
for (const q of QUESTIONS) console.log(`Q${q.id}  ${results.map((m) => money(m.questions.find((x) => x.id === q.id)!.usd).padStart(12)).join("")}`);

console.log("\nanswers");
for (const q of QUESTIONS) {
  for (const m of results) console.log(`\n[Q${q.id} ${m.mode}] ${m.questions.find((x) => x.id === q.id)!.answer.trim().slice(0, 700)}`);
}

mkdirSync("results", { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ model: MODEL, repo: REPO, price, results }, null, 2));
console.log(`\nSaved ${file}`);
