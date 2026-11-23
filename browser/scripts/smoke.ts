// Render smoke test: every screen must render without throwing.
//
// There is no browser in this sandbox, so this is the closest thing to "does the app boot".
// A tiny in-memory Storage stands in for localStorage/sessionStorage, then App and each view
// are rendered to a string with react-dom/server. Layout correctness still needs a real
// browser; a crash on first paint shows up right here.
//
// Run with: npm run smoke   (vite build --ssr, then node)

import * as React from "react";
import { renderToString } from "react-dom/server";

class MemoryStorage {
  #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(k: string): string | null {
    return this.#map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
  key(i: number): string | null {
    return Array.from(this.#map.keys())[i] ?? null;
  }
}

const g = globalThis as unknown as { localStorage: Storage; sessionStorage: Storage; window?: unknown };
g.localStorage = new MemoryStorage() as unknown as Storage;
g.sessionStorage = new MemoryStorage() as unknown as Storage;

const { App } = await import("../src/App.tsx");
const { WorkspaceApiProbe, ApprovalProbe } = await import("./probe.tsx");

const problems: string[] = [];

function check(name: string, fn: () => string, expect: string[] = []) {
  try {
    const html = fn();
    if (html.length < 40) problems.push(`${name}: rendered almost nothing (${html.length} chars)`);
    for (const needle of expect) {
      if (!html.includes(needle)) problems.push(`${name}: expected ${JSON.stringify(needle)} in the output`);
    }
    console.log(`ok   ${name.padEnd(28)} ${html.length} chars`);
  } catch (err) {
    problems.push(`${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    console.log(`FAIL ${name}`);
  }
}

// 1. A brand-new install lands on Setup — no task UI, no reliance on stored state.
check("first run → setup", () => renderToString(React.createElement(App)), [
  "in your browser",
  "OpenRouter",
]);

// 2. A configured workspace renders the task list and every other route.
localStorage.setItem(
  "artex-browser.workspace",
  JSON.stringify({
    version: 1,
    acceptedTerms: true,
    createdAt: Date.now(),
    llm: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat-v3-0324",
      apiKey: "",
      temperature: 0.2,
      maxTokens: 2048,
    },
    tasks: [
      {
        id: "t1",
        name: "Login review",
        goal: "Look for missing rate limits on /login.",
        targets: ["example.com"],
        extraScope: [{ domain: "example.com", raw: "example.com" }],
        turnBudget: 8,
        requestBudget: 20,
        status: "done",
        createdAt: Date.now() - 3_600_000,
        startedAt: Date.now() - 3_500_000,
        endedAt: Date.now() - 3_400_000,
        turnsUsed: 4,
        requestsUsed: 7,
        tokens: { input: 1200, output: 300, calls: 4 },
        findings: [
          {
            id: "f1",
            title: "No rate limit on /login",
            severity: "high",
            asset: "example.com",
            evidence: "20 requests in 2s all returned 200",
            remediation: "Add per-IP throttling.",
            createdAt: Date.now() - 3_450_000,
          },
        ],
        hypotheses: [
          { id: "h1", text: "Session cookie may be reusable after logout", status: "untested", createdAt: Date.now() - 3_460_000 },
        ],
        tools: [
          {
            id: "l1",
            at: Date.now() - 3_470_000,
            turn: 1,
            name: "http_request",
            args: { url: "https://example.com/login" },
            status: "ok",
            summary: "GET https://example.com/login → 200",
            target: "https://example.com/login",
            durationMs: 120,
          },
        ],
        transcript: [
          { id: "tr1", at: Date.now() - 3_470_000, role: "assistant", text: "Checking /login for throttling." },
          { id: "tr2", at: Date.now() - 3_400_000, role: "system", text: "Run finished." },
        ],
        summary: "One finding: no rate limit.",
      },
    ],
    activeTaskId: "t1",
  }),
);
localStorage.setItem("artex-browser.settings", JSON.stringify({ turnDelayMs: 400, blockPrivateRanges: true, approveNewHosts: true }));
sessionStorage.setItem("artex-browser.session.key", "sk-smoke-test-key");

check("configured → tasks", () => renderToString(React.createElement(App)), [
  "Login review",
  "New task",
  "Findings",
]);

// The run panel for the selected task: trace, tool log, findings, hypotheses, scope.
check("selected task run panel", () => renderToString(React.createElement(WorkspaceApiProbe, { screen: "tasks" })), [
  "Login review",
  "Trace",
  "Tool calls",
  "Findings",
]);

// 3. Every view, rendered directly against the same state hook.
check("setup view", () => renderToString(React.createElement(WorkspaceApiProbe, { screen: "setup" })));
check("new task view", () => renderToString(React.createElement(WorkspaceApiProbe, { screen: "new" })), [
  "Targets",
  "Goal",
]);
check("tasks view", () => renderToString(React.createElement(WorkspaceApiProbe, { screen: "tasks" })));
check("findings view", () => renderToString(React.createElement(WorkspaceApiProbe, { screen: "findings" })), [
  "No rate limit on /login",
  "example.com",
]);
check("settings view", () => renderToString(React.createElement(WorkspaceApiProbe, { screen: "settings" })));
check("approval dialog", () => renderToString(React.createElement(ApprovalProbe)));

// 4. An empty but configured workspace must not crash (the "no tasks yet" path).
localStorage.setItem(
  "artex-browser.workspace",
  JSON.stringify({
    version: 1,
    acceptedTerms: true,
    createdAt: Date.now(),
    llm: {
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
      apiKey: "",
      temperature: 0.2,
      maxTokens: 2048,
    },
    tasks: [],
  }),
);
check("configured, no tasks", () => renderToString(React.createElement(App)));

if (problems.length > 0) {
  console.error(`\n${problems.length} smoke problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nall screens rendered");
