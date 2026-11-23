import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyHttpError,
  classifyNetworkError,
  clipNote,
  isSeverity,
  runLoop,
  severityRank,
  summarizeAction,
  systemPrompt,
  TOOLS,
} from "../lib/agent.ts";
import type { LlmTransport, LoopDeps, LoopEvent, ToolTransport, TurnContext } from "../lib/agent.ts";
import type { Finding, ToolCall } from "../lib/types.ts";

function baseContext(turn = 1): TurnContext {
  return {
    goal: "Check the login flow for missing rate limits.",
    scopeLines: ["example.com (+ subdomains)"],
    turn,
    turnBudget: 8,
    requestsUsed: 0,
    requestBudget: 20,
    findings: [],
    recentActions: [],
    notes: [],
  };
}

function deps(over: Partial<LoopDeps> & { script?: ToolCall[][] } = {}): LoopDeps {
  const script = over.script ?? [];
  let call = 0;
  const llm: LlmTransport = {
    chat: async () => {
      const toolCalls = script[call++] ?? [];
      return { text: `turn ${call}`, toolCalls, usage: { input: 10, output: 5 } };
    },
  };
  const tools: ToolTransport = {
    run: async () => ({ ok: true, text: "HTTP 200 OK" }),
  };
  return {
    llm: over.llm ?? llm,
    tools: over.tools ?? tools,
    signal: over.signal ?? new AbortController().signal,
    history: over.history ?? [],
    buildContext: over.buildContext ?? ((turn) => baseContext(turn)),
    shouldContinue: over.shouldContinue ?? (() => true),
    onEvent: over.onEvent ?? (() => {}),
    maxTurns: over.maxTurns ?? 6,
    requestBudget: over.requestBudget ?? 20,
    requestsUsedBefore: over.requestsUsedBefore ?? 0,
    turnsUsedBefore: over.turnsUsedBefore ?? 0,
    delay: async () => {},
    turnDelayMs: 0,
  };
}

const httpCall: ToolCall = {
  id: "c-http",
  name: "http_request",
  args: { url: "https://example.com/login" },
  rawArgs: "{}",
};
const finishCall: ToolCall = {
  id: "c-fin",
  name: "finish",
  args: { summary: "No rate limit observed on /login." },
  rawArgs: "{}",
};

test("the system prompt states the goal, the scope and the budgets", () => {
  const prompt = systemPrompt({ ...baseContext(3), findings: [finding("high", "Missing CSP")], notes: ["saw a graphql endpoint"] });
  assert.ok(prompt.includes("Check the login flow"));
  assert.ok(prompt.includes("example.com (+ subdomains)"));
  assert.ok(prompt.includes("turn 3 of 8"));
  assert.ok(prompt.includes("Missing CSP"));
  assert.ok(prompt.includes("saw a graphql endpoint"));
  assert.ok(/non-destructive/i.test(prompt), "rules of engagement must be present");
});

test("every advertised tool has a name, description and object schema", () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, [
    "http_request",
    "dns_lookup",
    "record_finding",
    "report_hypothesis",
    "note",
    "finish",
  ]);
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal((tool.parameters as { type?: string }).type, "object", tool.name);
  }
});

test("the loop runs tool calls, then stops when the model calls finish", async () => {
  const events: LoopEvent[] = [];
  const reason = await runLoop(
    deps({
      script: [[httpCall], [finishCall]],
      onEvent: (e) => events.push(e),
    }),
  );
  assert.equal(reason, "finished");
  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes("assistant"));
  assert.equal(kinds.filter((k) => k === "tool_start").length, 2);
  const finish = events.find((e) => e.type === "finish");
  assert.equal(finish?.type === "finish" && finish.summary, "No rate limit observed on /login.");
  const usage = events.filter((e) => e.type === "usage");
  assert.equal(usage.length, 2, "usage is reported for each model call");
  // turn_end fires once per turn, and never after finish returns.
  assert.equal(events.filter((e) => e.type === "turn_end").length, 2);
});

test("the loop stops on budget when turns run out", async () => {
  const reason = await runLoop(deps({ maxTurns: 2, script: [[httpCall], [httpCall], [httpCall]] }));
  assert.equal(reason, "budget");
});

test("the request budget is enforced even when turns remain", async () => {
  const toolRuns: string[] = [];
  const tools: ToolTransport = {
    run: async (call) => {
      toolRuns.push(call.name);
      return { ok: true, text: "ok" };
    },
  };
  const many: ToolCall[] = [
    { ...httpCall, id: "a" },
    { ...httpCall, id: "b" },
  ];
  const reason = await runLoop(
    deps({ tools, script: [many, many, many], requestBudget: 3, maxTurns: 10 }),
  );
  assert.equal(reason, "budget");
  assert.equal(toolRuns.filter((n) => n === "http_request").length, 3, "never exceeds the request budget");
});

test("aborting the signal ends the run as aborted", async () => {
  const controller = new AbortController();
  const llm: LlmTransport = {
    chat: async () => {
      controller.abort();
      throw new Error("aborted by operator");
    },
  };
  const reason = await runLoop(deps({ llm, signal: controller.signal }));
  assert.equal(reason, "aborted");
});

test("pausing (shouldContinue false) ends the run as stopped without an error", async () => {
  let allowed = true;
  const reason = await runLoop(
    deps({
      shouldContinue: () => allowed,
      llm: {
        chat: async () => {
          allowed = false;
          return { text: "", toolCalls: [{ ...httpCall, id: "x" }] };
        },
      },
    }),
  );
  assert.equal(reason, "stopped");
});

test("a thrown transport error is reported as an error event, not a crash", async () => {
  const events: LoopEvent[] = [];
  const reason = await runLoop(
    deps({
      onEvent: (e) => events.push(e),
      llm: {
        chat: async () => {
          throw new Error("401 invalid api key");
        },
      },
    }),
  );
  assert.equal(reason, "error");
  const err = events.find((e) => e.type === "error");
  assert.equal(err?.type === "error" && err.message, "401 invalid api key");
});

test("a crashing tool becomes a failed observation instead of killing the loop", async () => {
  const events: LoopEvent[] = [];
  const tools: ToolTransport = {
    run: async () => {
      throw new Error("network down");
    },
  };
  const reason = await runLoop(
    deps({ tools, script: [[httpCall], [finishCall]], onEvent: (e) => events.push(e) }),
  );
  assert.equal(reason, "finished");
  const failed = events.find((e) => e.type === "tool_end" && !e.ok);
  assert.ok(failed, "the failure is surfaced as an unsuccessful tool_end");
});

test("a prose-only reply gets a nudge and does not end the run immediately", async () => {
  const prompts: number[] = [];
  const llm: LlmTransport = {
    chat: async (conv) => {
      prompts.push(conv.filter((c) => c.role === "system").length);
      return { text: "just thinking", toolCalls: [] };
    },
  };
  const reason = await runLoop(deps({ llm, maxTurns: 3 }));
  assert.equal(reason, "budget");
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((n) => n === 1), "exactly one system message per model call");
});

test("prior history is folded into the first model call once", async () => {
  const seen: string[] = [];
  const llm: LlmTransport = {
    chat: async (conv) => {
      seen.push(JSON.stringify(conv));
      return { text: "", toolCalls: [finishCall] };
    },
  };
  await runLoop(
    deps({
      llm,
      history: [
        { role: "user", text: "what did you find?" },
        { role: "assistant", text: "a missing header" },
      ],
    }),
  );
  assert.ok(seen[0]?.includes("what did you find?"));
  assert.ok(seen[0]?.includes("a missing header"));
});

test("summarizeAction describes each tool in one short line", () => {
  assert.ok(summarizeAction(httpCall).includes("example.com/login"));
  assert.ok(summarizeAction({ id: "d", name: "dns_lookup", args: { name: "example.com", type: "TXT" }, rawArgs: "{}" }).includes("TXT"));
  assert.ok(summarizeAction(finishCall).length > 0);
  assert.ok(summarizeAction({ id: "u", name: "unknown_tool", args: {}, rawArgs: "{}" }).includes("unknown_tool"));
});

test("clipNote bounds long notes", () => {
  const long = "x".repeat(5000);
  assert.ok(clipNote(long).length <= 1200);
  assert.equal(clipNote("short"), "short");
});

test("severity helpers agree with the domain model", () => {
  assert.equal(isSeverity("critical"), true);
  assert.equal(isSeverity("catastrophic"), false);
  assert.equal(isSeverity(7), false);
  assert.ok(severityRank("critical") < severityRank("low"));
  assert.ok(severityRank("low") < severityRank("info"));
});

test("HTTP errors are classified into actionable messages", () => {
  const auth = classifyHttpError(401, '{"error":{"message":"Incorrect API key"}}');
  assert.equal(auth.kind, "auth");
  assert.match(auth.message, /Incorrect API key/);
  assert.equal(auth.status, 401);

  assert.equal(classifyHttpError(429, "slow down").kind, "rate_limit");
  assert.equal(classifyHttpError(503, "upstream unavailable").kind, "server");
  assert.equal(classifyHttpError(404, '{"error":{"message":"model not found"}}').kind, "model");
  assert.equal(classifyHttpError(402, "insufficient balance").kind, "balance");
  assert.equal(classifyHttpError(400, "bad tool schema").kind, "bad_request");
});

test("network errors name the likely browser cause (CORS or bad URL)", () => {
  const cors = classifyNetworkError(new TypeError("Failed to fetch"), "https://api.openai.com/v1");
  assert.equal(cors.kind, "cors");
  assert.match(cors.message, /api\.openai\.com/);
  assert.match(cors.message, /CORS/);
  const aborted = classifyNetworkError(new DOMException("aborted", "AbortError"), "https://x.test");
  assert.match(aborted.message, /aborted/i);
});

function finding(severity: Finding["severity"], title: string): Finding {
  return {
    id: "f1",
    title,
    severity,
    asset: "example.com",
    evidence: "curl -I",
    remediation: "Add the header.",
    createdAt: Date.now(),
  };
}

test("a model that cannot call tools gets a specific, actionable message", () => {
  const info = classifyHttpError(
    400,
    '{"error":{"message":"registry.ollama.ai/library/x does not support tools"}}',
  );
  assert.equal(info.kind, "model");
  assert.match(info.message, /does not accept tool calls/);
  assert.match(info.message, /tool-capable model/);
  assert.match(info.message, /does not support tools/, "the provider's own words are kept");
});
