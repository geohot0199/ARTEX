import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  emptyWorkspace,
  forgetApiKey,
  hydrateConfig,
  keyRemembered,
  loadApiKey,
  loadSettings,
  loadWorkspace,
  redactConfig,
  saveApiKey,
  saveSettings,
  saveWorkspace,
} from "../lib/storage.ts";
import type { LLMConfig, Task, Workspace } from "../lib/types.ts";

/** Minimal in-memory Storage so the tests do not need a browser (or globals). */
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
}

// storage.ts reads globalThis.localStorage/sessionStorage by default.
const local = new MemoryStorage();
const session = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = local;
(globalThis as unknown as { sessionStorage: MemoryStorage }).sessionStorage = session;

function task(id = "t1"): Task {
  return {
    id,
    name: "Login review",
    goal: "Look for rate limiting",
    targets: ["example.com"],
    extraScope: [{ domain: "example.com", raw: "example.com" }],
    turnBudget: 8,
    requestBudget: 20,
    status: "idle",
    createdAt: 1_700_000_000_000,
    turnsUsed: 0,
    requestsUsed: 0,
    tokens: { input: 0, output: 0, calls: 0 },
    findings: [],
    hypotheses: [],
    transcript: [],
    tools: [],
  };
}

function reset(): void {
  local.clear();
  session.clear();
}

test("an empty store yields a usable empty workspace", () => {
  reset();
  const ws = loadWorkspace(local as unknown as Storage);
  assert.equal(ws.version, 1);
  assert.deepEqual(ws.tasks, []);
  assert.equal(ws.acceptedTerms, false);
});

test("a workspace round-trips through storage", () => {
  reset();
  const ws: Workspace = {
    ...emptyWorkspace(),
    tasks: [task()],
    activeTaskId: "t1",
    acceptedTerms: true,
    llm: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat-v3-0324",
      apiKey: "",
      temperature: 0.2,
      maxTokens: 2048,
    },
  };
  saveWorkspace(ws, local as unknown as Storage);
  const back = loadWorkspace(local as unknown as Storage);
  assert.equal(back.tasks.length, 1);
  assert.equal(back.tasks[0]?.name, "Login review");
  assert.equal(back.activeTaskId, "t1");
  assert.equal(back.acceptedTerms, true);
  assert.equal(back.llm?.model, "deepseek/deepseek-chat-v3-0324");
});

test("the API key is never written into the workspace blob", () => {
  reset();
  const ws: Workspace = {
    ...emptyWorkspace(),
    llm: {
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      apiKey: "gsk_secret_value",
      temperature: 0.2,
      maxTokens: 1024,
    },
  };
  saveWorkspace(ws, local as unknown as Storage);
  const raw = local.getItem("artex-browser.workspace") ?? "";
  assert.equal(raw.includes("gsk_secret_value"), false, "the key must be stripped before persisting");
  assert.equal(loadWorkspace(local as unknown as Storage).llm?.apiKey, "");
});

test("corrupt or foreign blobs fall back to an empty workspace", () => {
  reset();
  local.setItem("artex-browser.workspace", "{{{not json");
  assert.deepEqual(loadWorkspace(local as unknown as Storage).tasks, []);

  local.setItem("artex-browser.workspace", JSON.stringify({ version: 99, tasks: [task()] }));
  assert.deepEqual(loadWorkspace(local as unknown as Storage).tasks, [], "unknown schema version is ignored");

  local.setItem("artex-browser.workspace", JSON.stringify({ version: 1, tasks: [{ nope: true }, task()] }));
  const ws = loadWorkspace(local as unknown as Storage);
  assert.equal(ws.tasks.length, 1, "malformed task entries are dropped, valid ones survive");
});

test("settings round-trip and default sensibly", () => {
  reset();
  assert.deepEqual(loadSettings(local as unknown as Storage), DEFAULT_SETTINGS);
  saveSettings({ turnDelayMs: 1200, blockPrivateRanges: true, approveNewHosts: true }, local as unknown as Storage);
  const back = loadSettings(local as unknown as Storage);
  assert.equal(back.turnDelayMs, 1200);
  assert.equal(back.blockPrivateRanges, true);
  assert.equal(back.approveNewHosts, true);

  local.setItem("artex-browser.settings", "garbage");
  assert.deepEqual(loadSettings(local as unknown as Storage), DEFAULT_SETTINGS);
});

test("an unremembered key lives in sessionStorage only", () => {
  reset();
  saveApiKey("sk-live-123", false);
  assert.equal(loadApiKey(), "sk-live-123");
  assert.equal(keyRemembered(), false);
  assert.equal(local.getItem("artex-browser.session.key"), null, "localStorage stays clean");

  // A new tab = a new session: the key is gone.
  session.clear();
  assert.equal(loadApiKey(), "");
});

test("a remembered key survives the session and can be forgotten", () => {
  reset();
  saveApiKey("sk-live-456", true);
  assert.equal(keyRemembered(), true);
  assert.equal(local.getItem("artex-browser.session.key"), "sk-live-456");

  session.clear();
  assert.equal(loadApiKey(), "sk-live-456", "remembered keys are read back after the session ends");

  forgetApiKey();
  assert.equal(loadApiKey(), "");
  assert.equal(keyRemembered(), false);
  assert.equal(local.getItem("artex-browser.session.key"), null);
});

test("static hosting blocks storage without breaking the app", () => {
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  assert.deepEqual(loadWorkspace(throwing).tasks, []);
  assert.deepEqual(loadSettings(throwing), DEFAULT_SETTINGS);
  assert.doesNotThrow(() => saveWorkspace(emptyWorkspace(), throwing));
  assert.doesNotThrow(() => saveSettings(DEFAULT_SETTINGS, throwing));
});

test("redactConfig keeps the shape but drops the secret; hydrateConfig restores it", () => {
  const cfg: LLMConfig = {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "sk-real",
    temperature: 0.2,
    maxTokens: 1024,
  };
  const redacted = redactConfig(cfg);
  assert.notEqual(redacted?.apiKey, "sk-real", "the secret never survives redaction");
  assert.equal(redacted?.model, "gpt-4o-mini");
  assert.equal(redactConfig(undefined), undefined);

  // hydrateConfig fills the key from wherever the app keeps it (here: storage).
  // A masked placeholder must never be mistaken for a real credential.
  assert.equal(hydrateConfig(redacted)?.apiKey, "", "no stored key means no key");
  saveApiKey("sk-restored", false);
  const hydrated = hydrateConfig(redacted);
  assert.equal(hydrated?.apiKey, "sk-restored");
  assert.equal(hydrated?.provider, "openai");

  // An imported config that contains the mask falls back to the stored key, never the mask.
  assert.equal(hydrateConfig({ ...cfg, apiKey: "••••••••" })?.apiKey, "sk-restored");
});
