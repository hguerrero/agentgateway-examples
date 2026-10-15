import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Do tool modes and Headroom stack?
//   agentgateway toolMode shrinks the tool catalog (and the round trips).
//   Headroom shrinks the content: tool results and conversation history.
// This runs every GitHub question through  mode (standard | search | code)  x  Headroom (off | on)  x  repo (small | large),
// and scores each answer against the standard / Headroom-off answer with an LLM judge.
//
//   Headroom OFF:  harness -> gateway /v1/messages -> Anthropic
//   Headroom ON:   harness -> Headroom -> gateway /v1/messages -> Anthropic
// The MCP calls go to the gateway in both cases, so the two knobs act on different requests.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const HEADROOM_URL = process.env.HEADROOM_URL ?? "http://localhost:8787";
const MODEL = process.env.MODEL ?? "claude-opus-5-5";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? MODEL;
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const MODES = list(process.env.MODES, "standard,search,code");
const HEADROOM_STATES = list(process.env.HEADROOM, "off,on");
const REPO_SELECT = list(process.env.REPOS, "small,large");
const QUESTION_SELECT = process.env.QUESTIONS ? list(process.env.QUESTIONS, "") : undefined;
const REPOS: Record<string, string> = {
  small: process.env.REPO_SMALL ?? "hguerrero/agentgateway-examples",
  large: process.env.REPO_LARGE ?? "agentgateway/agentgateway",
};
// Prompt caching is on for every cell, like a production agent: one breakpoint on the system block (it covers the
// tool catalog before it) and one on the growing conversation. This is what makes the comparison honest. The big,
// stable catalog caches well, and a proxy that rewrites the prompt can lose that.
// Each cell gets its own id in the system prompt, so cells never share a cache entry. Without it, whichever cell runs
// first pays the cache write and the next one reads it for free, and the cost difference would not be about Headroom.
const PROMPT_CACHE = (process.env.PROMPT_CACHE ?? "on") !== "off";
const JUDGE = (process.env.JUDGE ?? "on") !== "off";
const MAX_TURNS = 12;
const MAX_RESULT_CHARS = 250_000; // safety net only; GitHub list results can be 80 KB or more

// USD per million tokens. Override with PRICE_INPUT / PRICE_OUTPUT for other models.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const base = PRICES[MODEL] ?? { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN };
const price = {
  input: process.env.PRICE_INPUT ? Number(process.env.PRICE_INPUT) : base.input,
  output: process.env.PRICE_OUTPUT ? Number(process.env.PRICE_OUTPUT) : base.output,
  cacheRead: process.env.PRICE_INPUT ? Number(process.env.PRICE_INPUT) * 0.05 : base.cacheRead,
  cacheWrite: process.env.PRICE_INPUT ? Number(process.env.PRICE_INPUT) * 1.25 : base.cacheWrite,
};

// What each mode must expose. If it does not, the gateway is not the Enterprise build (the open-source
// proxy ignores toolMode and serves every tool) or the license did not load.
const EXPECTED: Record<string, (n: string[]) => boolean> = {
  standard: (n) => n.length > 2 && !n.includes("run_code") && !n.includes("get_tool"),
  search: (n) => n.length === 2 && n.includes("get_tool") && n.includes("invoke_tool"),
  code: (n) => n.length === 1 && n[0] === "run_code",
};

const QUESTIONS = (repo: string) =>
  [
    { id: "repo", text: `Describe the repository ${repo}: its description, default branch, primary language and number of open issues.` },
    { id: "commits", text: `List the 5 most recent commits on ${repo}: the 7-character SHA, the author and the subject of each.` },
    { id: "issues", text: `List the open issues in ${repo} with their numbers, titles and authors. Fetch the first page with perPage set to 30.` },
    { id: "prs", text: `List the open pull requests in ${repo} with their numbers, titles and authors. Fetch the first page with perPage set to 30.` },
    { id: "contents", text: `List the files and folders in the root directory of ${repo}.` },
  ].filter((q) => !QUESTION_SELECT || QUESTION_SELECT.includes(q.id));

const system = (repo: string, cell: string): Anthropic.TextBlockParam[] => [
  {
    type: "text",
    text:
      `You are a read-only GitHub assistant. You may ONLY access the repository ${repo}. ` +
      `Never query, search or reference any other repository. If a request would need another repo, refuse. Answer concisely. (session ${cell})`,
    ...(PROMPT_CACHE ? { cache_control: { type: "ephemeral" as const } } : {}),
  },
];

// Headroom OFF talks to the gateway. Headroom ON talks to Headroom, which forwards to the gateway.
const llm = {
  off: new Anthropic({ baseURL: GATEWAY_URL, apiKey: "set-by-the-gateway" }),
  on: new Anthropic({ baseURL: HEADROOM_URL, apiKey: "set-by-the-gateway" }),
};

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Row = {
  repo: string; repoName: string; mode: string; headroom: string; question: string;
  modelCalls: number; toolCalls: number; usage: Usage; usd: number; ok: boolean; error?: string; truncated: boolean; answer: string;
  quality?: number; why?: string;
};
const usd = (u: Usage) => (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1e6;
const promptTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

async function ask(hr: "off" | "on", mcp: Client, tools: Anthropic.Tool[], repo: string, text: string, cell: string) {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let modelCalls = 0, toolCalls = 0, truncated = false, answer = "";
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: text }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await llm[hr].messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: "low" },
      system: system(repo, cell),
      tools,
      messages,
      ...(PROMPT_CACHE ? { cache_control: { type: "ephemeral" as const } } : {}),
    });
    modelCalls++;
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "text") answer = block.text;
      if (block.type !== "tool_use") continue;
      toolCalls++;
      // A failed call (bad arguments, upstream error) goes back to the model as an error result.
      let out: string;
      let isError = false;
      try {
        const result = await mcp.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
        out = (result.content as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        isError = result.isError === true;
      } catch (e) {
        out = e instanceof Error ? e.message : String(e);
        isError = true;
      }
      if (out.length > MAX_RESULT_CHARS) {
        truncated = true;
        out = `${out.slice(0, MAX_RESULT_CHARS)}\n... (truncated, ${out.length} chars)`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: out, is_error: isError });
    }
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "tool_use") messages.push({ role: "user", content: results });
    else if (response.stop_reason !== "pause_turn") return { modelCalls, toolCalls, usage, truncated, answer, ok: answer.length > 0 };
  }
  return { modelCalls, toolCalls, usage, truncated, answer, ok: false };
}

// ---- run the matrix
const rows: Row[] = [];
const connections: Record<string, { mcp: Client; tools: Anthropic.Tool[] }> = {};
for (const mode of MODES) {
  const mcp = new Client({ name: "headroom-matrix", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${GATEWAY_URL}/mcp/${mode}`)));
  const listed = (await mcp.listTools()).tools;
  const names = listed.map((t) => t.name);
  if (!EXPECTED[mode]?.(names)) {
    throw new Error(
      `/mcp/${mode} exposes ${names.length} tool(s) (${names.slice(0, 4).join(", ")}...), not what toolMode "${mode}" should expose. ` +
        `Is this the Solo Enterprise build with a valid license? The open-source proxy always runs in standard mode.`,
    );
  }
  connections[mode] = { mcp, tools: listed.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema })) };
}
if (HEADROOM_STATES.includes("on")) {
  const ok = await fetch(`${HEADROOM_URL}/health`).then((r) => r.ok).catch(() => false);
  if (!ok) throw new Error(`Headroom does not answer at ${HEADROOM_URL}. Start it with ./scripts/run-headroom.sh, or run with HEADROOM=off.`);
}

console.log(`Model ${MODEL}, prompt cache ${PROMPT_CACHE ? "on" : "off"}, modes ${MODES.join("/")}, Headroom ${HEADROOM_STATES.join("/")}`);
for (const repoKey of REPO_SELECT) {
  const repo = REPOS[repoKey];
  if (!repo) throw new Error(`unknown repo "${repoKey}" (use small or large)`);
  for (const hr of HEADROOM_STATES as ("off" | "on")[]) {
    for (const mode of MODES) {
      const { mcp, tools } = connections[mode];
      const cell = randomUUID().slice(0, 8);
      process.stdout.write(`\n[${repoKey} ${repo}] mode=${mode} headroom=${hr}\n`);
      for (const q of QUESTIONS(repo)) {
        const row: Row = { repo: repoKey, repoName: repo, mode, headroom: hr, question: q.id, modelCalls: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0, ok: false, truncated: false, answer: "" };
        try {
          Object.assign(row, await ask(hr, mcp, tools, repo, q.text, cell));
        } catch (e) {
          row.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
        }
        row.usd = usd(row.usage);
        rows.push(row);
        console.log(`  ${q.id.padEnd(9)} ${String(row.modelCalls).padStart(2)} calls  ${String(promptTokens(row.usage)).padStart(7)} prompt tok (${row.usage.cacheRead} read, ${row.usage.cacheWrite} written)  ${String(row.usage.output).padStart(5)} out  $${row.usd.toFixed(4)}${row.error ? `  ERROR ${row.error}` : ""}${row.truncated ? "  (truncated)" : ""}`);
      }
    }
  }
}
for (const c of Object.values(connections)) await c.mcp.close();

// ---- quality judge: score each answer against the standard / Headroom-off answer. The judge call is
// always sent straight to the gateway, so the grader never reads compressed text.
const JUDGE_SYS =
  "You are a strict grader. Given a QUESTION, a reference BASELINE answer and a CANDIDATE answer, score how well the candidate matches " +
  "the baseline's factual content and completeness, from 0 (wrong, empty or refuses) to 5 (fully equivalent in facts and coverage). " +
  'Ignore wording and formatting differences. Identifiers such as commit SHAs must match exactly. Reply with ONLY a JSON object: {"score": <int 0-5>, "why": "<one short line>"}.';
if (JUDGE) {
  const baseline = new Map(rows.filter((r) => r.mode === "standard" && r.headroom === "off").map((r) => [`${r.repo}/${r.question}`, r]));
  const questionText = new Map(REPO_SELECT.flatMap((k) => QUESTIONS(REPOS[k]).map((q) => [`${k}/${q.id}`, q.text] as const)));
  for (const r of rows) {
    const b = baseline.get(`${r.repo}/${r.question}`);
    if (!b || !b.answer) continue;
    if (r === b) { r.quality = 5; r.why = "baseline"; continue; }
    try {
      const res = await llm.off.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 300,
        output_config: { effort: "low" },
        system: JUDGE_SYS,
        messages: [{ role: "user", content: `QUESTION:\n${questionText.get(`${r.repo}/${r.question}`)}\n\nBASELINE:\n${b.answer}\n\nCANDIDATE:\n${r.answer || "(no answer)"}` }],
      });
      const txt = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const obj = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
      r.quality = Math.max(0, Math.min(5, Math.round(Number(obj.score))));
      r.why = String(obj.why ?? "");
    } catch {
      r.quality = 0;
      r.why = "unparseable judge reply";
    }
  }
}

// ---- report
const sum = (xs: Row[], f: (r: Row) => number) => xs.reduce((a, r) => a + f(r), 0);
const cell = (repo: string | undefined, mode: string, hr: string) => rows.filter((r) => (!repo || r.repo === repo) && r.mode === mode && r.headroom === hr);
const money = (n: number) => `$${n.toFixed(4)}`;
const delta = (off: number, on: number) => (off ? `${on <= off ? "-" : "+"}${Math.abs(Math.round(((on - off) / off) * 100))}%` : "");
const q = (xs: Row[]) => (xs.some((r) => r.quality !== undefined) ? (sum(xs, (r) => r.quality ?? 0) / xs.length).toFixed(1) : "n/a");
const fails = (xs: Row[]) => xs.filter((r) => !r.ok).length;

function table(title: string, repo: string | undefined) {
  console.log(`\n${title}`);
  console.log("mode        OFF cost    ON cost   change   OFF prompt tok   ON prompt tok   OFF quality   ON quality   failed (off/on)");
  for (const mode of MODES) {
    const off = cell(repo, mode, "off"), on = cell(repo, mode, "on");
    if (!off.length && !on.length) continue;
    const a = sum(off, (r) => r.usd), b = sum(on, (r) => r.usd);
    console.log(
      `${mode.padEnd(11)} ${money(a).padStart(8)}  ${on.length ? money(b).padStart(8) : "     n/a"}   ${on.length && off.length ? delta(a, b).padStart(6) : "      "}   ${String(sum(off, (r) => promptTokens(r.usage))).padStart(14)}   ${String(sum(on, (r) => promptTokens(r.usage))).padStart(13)}   ${q(off).padStart(11)}   ${q(on).padStart(10)}   ${fails(off)}/${fails(on)}`,
    );
  }
}
for (const k of REPO_SELECT) table(`Repo ${k}: ${REPOS[k]}`, k);
if (REPO_SELECT.length > 1) table("Both repos together", undefined);

if (JUDGE) {
  console.log("\nAnswers that scored below 4 (candidate vs the standard / Headroom-off answer)");
  const low = rows.filter((r) => r.quality !== undefined && r.quality < 4);
  if (!low.length) console.log("  none");
  for (const r of low) console.log(`  ${r.repo} ${r.mode} headroom=${r.headroom} ${r.question}: ${r.quality}/5  ${r.why}`);
}

mkdirSync("results", { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ model: MODEL, judgeModel: JUDGE ? JUDGE_MODEL : null, promptCache: PROMPT_CACHE, price, repos: REPOS, rows }, null, 2));
console.log(`\nSaved ${file}`);
