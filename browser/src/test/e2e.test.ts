// End-to-end: a real HTTP round trip through wire.ts + client.ts + agent.ts.
//
// Two throwaway loopback servers stand in for the outside world:
//   * a mock model provider that speaks OpenAI chat-completions (including tool calls)
//   * a mock "target" site whose responses the agent is supposed to report on
//
// Nothing is stubbed inside the app: chatCompletion does a real fetch, runLoop drives the
// real loop, and the tool transport really performs the HTTP request. The only thing absent
// is a browser, so the CORS layer is not exercised here (it cannot be, without a browser).

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { runLoop } from "../lib/agent.ts";
import type { LoopEvent } from "../lib/agent.ts";
import { chatCompletion, rawHttp } from "../lib/client.ts";
import { checkRequestTarget, describeScope, parseScopeItem } from "../lib/scope.ts";
import type { LLMConfig, ToolCall } from "../lib/types.ts";

interface MockServer {
  url: string;
  close: () => Promise<void>;
  /** Every request the server saw, for assertions. */
  requests: { method: string; path: string; body: string; headers: http.IncomingHttpHeaders }[];
}

async function listen(handler: http.RequestListener): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** A provider that plays a fixed script of tool calls, one per request. */
async function mockProvider(script: ToolCall[]): Promise<MockServer> {
  let turn = 0;
  return listen((_req, res) => {
    const call = script[turn++];
    if (!call) {
      json(res, 200, { choices: [{ message: { content: "I am done." }, finish_reason: "stop" }] });
      return;
    }
    json(res, 200, {
      choices: [
        {
          message: {
            content: `Step ${turn}.`,
            tool_calls: [
              {
                id: `${call.id}-${turn}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
  });
}

function cfgFor(url: string): LLMConfig {
  return {
    provider: "custom",
    baseUrl: `${url}/v1`,
    model: "mock-model",
    apiKey: "sk-mock",
    temperature: 0.2,
    maxTokens: 512,
  };
}

test("a full run: the agent requests the target, records a finding, and finishes", async () => {
  const target = await listen((req, res) => {
    if (req.url === "/login") {
      // A deliberately bare response: no security headers, no throttling.
      res.writeHead(200, { "content-type": "text/html", server: "mock/1.0" });
      res.end("<html><title>Login</title><body>try again</body></html>");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const provider = await mockProvider([
    { id: "s1", name: "http_request", args: { url: `${target.url}/login`, method: "GET" }, rawArgs: "{}" },
    {
      id: "s2",
      name: "record_finding",
      args: {
        title: "No rate limiting on /login",
        severity: "medium",
        asset: "127.0.0.1",
        evidence: "20 rapid POSTs all returned 200",
        remediation: "Add per-IP throttling.",
      },
      rawArgs: "{}",
    },
    { id: "s3", name: "finish", args: { summary: "One finding recorded." }, rawArgs: "{}" },
  ]);

  const events: LoopEvent[] = [];
  const scopeInput = parseScopeItem("127.0.0.1");
  assert.equal(scopeInput.ok, true);
  const rules = scopeInput.ok ? scopeInput.rules : [];

  const reason = await runLoop({
    llm: {
      chat: (conv, tools, signal) => chatCompletion(cfgFor(provider.url), conv, tools, signal),
    },
    tools: {
      run: async (call) => {
        if (call.name === "http_request") {
          const targetUrl = String(call.args.url ?? "");
          const check = checkRequestTarget(targetUrl, rules, { blockPrivate: false });
          if (!check.ok) return { ok: false, text: `Blocked by scope policy: ${check.reason}` };
          const result = await rawHttp(call.args, new AbortController().signal);
          return { ok: result.ok, text: result.text };
        }
        if (call.name === "record_finding") {
          const title = String(call.args.title ?? "");
          const severity = String(call.args.severity ?? "");
          if (!title) return { ok: false, text: "A finding needs a title." };
          if (!["critical", "high", "medium", "low", "info"].includes(severity)) {
            return { ok: false, text: `Invalid severity ${severity}.` };
          }
          return { ok: true, text: `Finding recorded: [${severity}] ${title}` };
        }
        if (call.name === "finish") return { ok: true, text: "Run finished." };
        return { ok: false, text: `Unknown tool ${call.name}.` };
      },
    },
    signal: new AbortController().signal,
    history: [],
    buildContext: (turn) => ({
      goal: "Check /login for missing rate limiting.",
      scopeLines: describeScope(rules),
      turn,
      turnBudget: 6,
      requestsUsed: 0,
      requestBudget: 5,
      findings: [],
      recentActions: [],
      notes: [],
    }),
    shouldContinue: () => true,
    onEvent: (e) => events.push(e),
    maxTurns: 6,
    requestBudget: 5,
    requestsUsedBefore: 0,
    turnsUsedBefore: 0,
    delay: async () => {},
    turnDelayMs: 0,
  });

  assert.equal(reason, "finished");

  // The provider saw three model calls, each with the tool schema and the bearer key.
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.requests[0]?.headers.authorization, "Bearer sk-mock");
  const firstBody = JSON.parse(provider.requests[0]?.body ?? "{}") as { tools?: { function: { name: string } }[] };
  assert.ok(firstBody.tools?.some((t) => t.function.name === "http_request"));
  // The real observation came back to the model on the next turn.
  const secondBody = JSON.parse(provider.requests[1]?.body ?? "{}") as { messages: { role: string; content: string }[] };
  const toolMessage = secondBody.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage, "the tool result is fed back to the model");
  assert.match(toolMessage.content, /HTTP 200/);
  assert.match(toolMessage.content, /mock\/1\.0/, "readable response headers reach the model");

  // The target really was contacted, exactly once.
  assert.equal(target.requests.filter((r) => r.path === "/login").length, 1);

  // The finding was accepted and the run reported usage.
  const recorded = events.find((e) => e.type === "tool_end" && e.call.name === "record_finding");
  assert.equal(recorded?.type === "tool_end" && recorded.ok, true);
  const usage = events.filter((e) => e.type === "usage");
  assert.equal(usage.length, 3);
  assert.equal(events.filter((e) => e.type === "finish").length, 1);

  await provider.close();
  await target.close();
});

test("out-of-scope hosts are refused before any request leaves", async () => {
  const target = await listen((_req, res) => {
    res.writeHead(200);
    res.end("should never be reached");
  });
  const provider = await mockProvider([
    { id: "x1", name: "http_request", args: { url: `${target.url}/secret` }, rawArgs: "{}" },
    { id: "x2", name: "finish", args: { summary: "Blocked, stopping." }, rawArgs: "{}" },
  ]);

  const scope = parseScopeItem("example.com");
  const rules = scope.ok ? scope.rules : [];
  const results: string[] = [];

  const reason = await runLoop({
    llm: { chat: (conv, tools, signal) => chatCompletion(cfgFor(provider.url), conv, tools, signal) },
    tools: {
      run: async (call) => {
        if (call.name !== "http_request") return { ok: true, text: "ok" };
        const check = checkRequestTarget(String(call.args.url ?? ""), rules, { blockPrivate: false });
        if (!check.ok) {
          results.push(check.reason);
          return { ok: false, text: `Blocked by scope policy: ${check.reason}` };
        }
        await rawHttp(call.args, new AbortController().signal);
        return { ok: true, text: "requested" };
      },
    },
    signal: new AbortController().signal,
    history: [],
    buildContext: () => ({
      goal: "Stay in scope.",
      scopeLines: describeScope(rules),
      turn: 1,
      turnBudget: 3,
      requestsUsed: 0,
      requestBudget: 3,
      findings: [],
      recentActions: [],
      notes: [],
    }),
    shouldContinue: () => true,
    onEvent: () => {},
    maxTurns: 3,
    requestBudget: 3,
    requestsUsedBefore: 0,
    turnsUsedBefore: 0,
    delay: async () => {},
    turnDelayMs: 0,
  });

  assert.equal(reason, "finished");
  assert.equal(results.length, 1, "the scope gate ran");
  assert.match(results[0] ?? "", /outside the task scope/);
  assert.equal(target.requests.length, 0, "the out-of-scope request was never sent");

  await provider.close();
  await target.close();
});

test("an HTTP error from the provider surfaces as a readable message, not a crash", async () => {
  const provider = await listen((_req, res) => {
    json(res, 401, { error: { message: "Incorrect API key provided: sk-mock" } });
  });
  await assert.rejects(
    () => chatCompletion(cfgFor(provider.url), [{ role: "user", text: "hi" }], [], new AbortController().signal),
    (err: Error) => {
      assert.match(err.message, /rejected the API key/i);
      assert.match(err.message, /Incorrect API key/);
      return true;
    },
  );
  await provider.close();
});

test("a non-JSON provider response is reported with a body excerpt", async () => {
  const provider = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>we are behind a captive portal</html>");
  });
  await assert.rejects(
    () => chatCompletion(cfgFor(provider.url), [{ role: "user", text: "hi" }], [], new AbortController().signal),
    (err: Error) => {
      assert.match(err.message, /not JSON/);
      assert.match(err.message, /captive portal/);
      return true;
    },
  );
  await provider.close();
});

test("an empty model reply is reported instead of spinning the loop", async () => {
  const provider = await listen((_req, res) => {
    json(res, 200, { choices: [{ message: { content: "" }, finish_reason: "length" }] });
  });
  await assert.rejects(
    () => chatCompletion(cfgFor(provider.url), [{ role: "user", text: "hi" }], [], new AbortController().signal),
    (err: Error) => {
      assert.match(err.message, /empty response/);
      assert.match(err.message, /length/);
      return true;
    },
  );
  await provider.close();
});

test("rawHttp reports a 404 target honestly and clips a huge body", async () => {
  const target = await listen((_req, res) => {
    if (res.req?.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("y".repeat(10_000));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });

  const notFound = await rawHttp({ url: `${target.url}/nope` }, new AbortController().signal);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.status, 404);
  assert.match(notFound.text, /HTTP 404/);

  const big = await rawHttp({ url: `${target.url}/big` }, new AbortController().signal);
  assert.equal(big.ok, true);
  assert.match(big.text, /body truncated/);
  assert.ok(big.text.length < 5_000, "the body is clipped before it reaches the model");
  assert.ok((big.durationMs ?? 0) >= 0);

  await target.close();
});
