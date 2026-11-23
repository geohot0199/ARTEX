import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS } from "../lib/agent.ts";
import { formatFor, chatRequest, modelsRequest, parseChatResponse, parseModelsResponse } from "../lib/wire.ts";
import type { ConvItem } from "../lib/wire.ts";
import type { LLMConfig, ProviderId } from "../lib/types.ts";

function cfg(provider: ProviderId, baseUrl: string, extra: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider,
    baseUrl,
    model: "test-model",
    apiKey: "sk-test",
    temperature: 0.2,
    maxTokens: 1024,
    ...extra,
  };
}

const conv: ConvItem[] = [
  { role: "system", text: "SYSTEM PROMPT" },
  { role: "user", text: "find something" },
  { role: "assistant", text: "trying", toolCalls: [{ id: "c1", name: "http_request", args: { url: "https://x.test/" }, rawArgs: "{}" }] },
  { role: "tool", toolCallId: "c1", name: "http_request", content: "OBSERVATION: 200" },
];

test("formatFor maps providers to their wire protocol", () => {
  assert.equal(formatFor(cfg("openrouter", "https://openrouter.ai/api/v1")), "openai");
  assert.equal(formatFor(cfg("openai", "https://api.openai.com/v1")), "openai");
  assert.equal(formatFor(cfg("anthropic", "https://api.anthropic.com/v1")), "anthropic");
  assert.equal(formatFor(cfg("gemini", "https://generativelanguage.googleapis.com/v1beta")), "gemini");
  assert.equal(formatFor(cfg("ollama", "http://localhost:11434")), "ollama");
});

test("OpenAI wire request carries bearer auth, model and tool specs", () => {
  const req = chatRequest(cfg("openrouter", "https://openrouter.ai/api/v1"), conv, TOOLS);
  assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 1024);
  assert.equal((body.tools as unknown[]).length, TOOLS.length);
  const toolNames = (body.tools as { function: { name: string } }[]).map((t) => t.function.name);
  assert.deepEqual(toolNames, TOOLS.map((t) => t.name));

  const messages = body.messages as { role: string; content: string; tool_calls?: unknown[] }[];
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "SYSTEM PROMPT");
  // The assistant turn keeps its tool call; the tool result becomes a role:"tool" message.
  const assistant = messages.find((m) => m.role === "assistant");
  assert.equal(assistant?.tool_calls?.length, 1);
  const toolMsg = messages.find((m) => m.role === "tool") as { tool_call_id?: string } | undefined;
  assert.equal(toolMsg?.tool_call_id, "c1");
});

test("Anthropic request asks for direct browser access and hoists the system prompt", () => {
  const req = chatRequest(cfg("anthropic", "https://api.anthropic.com/v1"), conv, TOOLS);
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "sk-test");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers["anthropic-dangerous-direct-browser-access"], "true");
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.system, "SYSTEM PROMPT");
  assert.equal(typeof body.max_tokens, "number");
  const messages = body.messages as { role: string; content: unknown }[];
  assert.ok(messages.every((m) => m.role !== "system"), "system must not appear in messages");
  // The tool result is expressed as a tool_result content block.
  const flat = JSON.stringify(messages);
  assert.ok(flat.includes("tool_result"));
  assert.ok(flat.includes("tool_use"));
});

test("Gemini request uses generateContent with a key query param and function declarations", () => {
  const req = chatRequest(cfg("gemini", "https://generativelanguage.googleapis.com/v1beta"), conv, TOOLS);
  assert.ok(req.url.includes("/models/test-model:generateContent"));
  assert.ok(req.url.includes("key=sk-test"));
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  const tools = body.tools as { functionDeclarations: { name: string }[] }[];
  assert.equal(tools[0]?.functionDeclarations.length, TOOLS.length);
  const contents = body.contents as { role: string; parts: unknown[] }[];
  assert.ok(contents.length > 0);
  assert.ok(JSON.stringify(body).includes("functionResponse"));
});

test("Ollama request hits /api/chat without an auth header", () => {
  const req = chatRequest(cfg("ollama", "http://localhost:11434"), conv, TOOLS);
  assert.equal(req.url, "http://localhost:11434/api/chat");
  assert.equal(req.headers.Authorization, undefined);
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.stream, false);
});

test("a model turn with invalid tool JSON is preserved for reporting back", () => {
  const turn = parseChatResponse("openai", {
    choices: [
      {
        message: {
          content: "here goes",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "http_request", arguments: "{not json" } }],
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });
  assert.equal(turn.text, "here goes");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]?.name, "http_request");
  assert.deepEqual(turn.toolCalls[0]?.args, {}, "invalid JSON falls back to an empty object");
  assert.equal(turn.toolCalls[0]?.rawArgs, "{not json");
  assert.deepEqual(turn.usage, { input: 11, output: 7 });
});

test("parsers understand each provider's envelope", () => {
  const openai = parseChatResponse("openai", {
    choices: [{ message: { content: "hello" } }],
  });
  assert.equal(openai.text, "hello");
  assert.equal(openai.toolCalls.length, 0);

  const anthropic = parseChatResponse("anthropic", {
    content: [
      { type: "text", text: "thinking about it" },
      { type: "tool_use", id: "tu_1", name: "dns_lookup", input: { name: "example.com" } },
    ],
    usage: { input_tokens: 5, output_tokens: 9 },
  });
  assert.equal(anthropic.text, "thinking about it");
  assert.equal(anthropic.toolCalls[0]?.name, "dns_lookup");
  assert.equal(anthropic.toolCalls[0]?.args.name, "example.com");
  assert.deepEqual(anthropic.usage, { input: 5, output: 9 });

  const gemini = parseChatResponse("gemini", {
    candidates: [
      {
        content: {
          parts: [{ text: "hi" }, { functionCall: { name: "note", args: { text: "remember this" } } }],
        },
      },
      ,
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
  });
  assert.equal(gemini.text, "hi");
  assert.equal(gemini.toolCalls[0]?.name, "note");
  assert.deepEqual(gemini.usage, { input: 3, output: 4 });

  const ollama = parseChatResponse("ollama", {
    message: { content: "yo", tool_calls: [{ function: { name: "finish", arguments: { summary: "done" } } }] },
    prompt_eval_count: 2,
    eval_count: 6,
  });
  assert.equal(ollama.text, "yo");
  assert.equal(ollama.toolCalls[0]?.name, "finish");
  assert.deepEqual(ollama.usage, { input: 2, output: 6 });
});

test("parseChatResponse survives empty or malformed payloads", () => {
  for (const format of ["openai", "anthropic", "gemini", "ollama"] as const) {
    const turn = parseChatResponse(format, {});
    assert.equal(turn.text, "", format);
    assert.deepEqual(turn.toolCalls, [], format);
  }
});

test("model listing requests and responses per format", () => {
  const openaiReq = modelsRequest(cfg("groq", "https://api.groq.com/openai/v1"));
  assert.equal(openaiReq.url, "https://api.groq.com/openai/v1/models");
  assert.equal(openaiReq.method, "GET");

  const anthropicReq = modelsRequest(cfg("anthropic", "https://api.anthropic.com/v1"));
  assert.equal(anthropicReq.headers["anthropic-dangerous-direct-browser-access"], "true");

  const ollamaReq = modelsRequest(cfg("ollama", "http://localhost:11434"));
  assert.equal(ollamaReq.url, "http://localhost:11434/api/tags");

  assert.deepEqual(
    parseModelsResponse("openai", { data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] }),
    ["a-model", "b-model"],
  );
  assert.deepEqual(
    parseModelsResponse("gemini", {
      models: [{ name: "models/gemini-2.5-flash" }, { name: "models/text-embedding-004" }],
    }),
    ["gemini-2.5-flash"],
    "embedding models are filtered out",
  );
  assert.deepEqual(parseModelsResponse("ollama", { models: [{ name: "llama3.2" }] }), ["llama3.2"]);
});

test("the model list can be filtered to tool-capable models", () => {
  const payload = {
    data: [
      { id: "vendor/agent-model", supported_parameters: ["tools", "tool_choice", "temperature"] },
      { id: "vendor/chat-only", supported_parameters: ["temperature", "top_p"] },
      { id: "vendor/unknown-shape" },
    ],
  };
  assert.deepEqual(parseModelsResponse("openai", payload), ["vendor/agent-model", "vendor/chat-only", "vendor/unknown-shape"]);
  assert.deepEqual(
    parseModelsResponse("openai", payload, (id) => id !== "vendor/chat-only"),
    ["vendor/agent-model", "vendor/unknown-shape"],
    "an entry without capability data is kept rather than guessed away",
  );
});

test("OpenRouter capability filtering keeps tool models and drops the rest", async () => {
  const { modelSupportsTools } = await import("../lib/providers.ts");
  assert.equal(modelSupportsTools("openrouter", { supported_parameters: ["tools"] }), true);
  assert.equal(modelSupportsTools("openrouter", { supported_parameters: ["tool_choice"] }), true);
  assert.equal(modelSupportsTools("openrouter", { supported_parameters: ["temperature"] }), false);
  assert.equal(modelSupportsTools("openrouter", {}), true, "no capability data is not a rejection");
  assert.equal(modelSupportsTools("openrouter", null), true);
  // Other providers do not publish this, so their lists pass through untouched.
  assert.equal(modelSupportsTools("groq", { supported_parameters: [] }), true);
});
