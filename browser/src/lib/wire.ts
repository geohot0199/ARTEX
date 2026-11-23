// Wire formats: turn the neutral conversation into each provider's HTTP request and
// parse the reply back into a ModelTurn.
//
// Everything here is a pure function so the four formats (OpenAI chat, Anthropic
// messages, Gemini generateContent, Ollama chat) can be unit-tested without a network.
// The runtime side (fetch, aborts, error classification) lives in client.ts.

import { PROVIDER_BY_ID } from "./providers.ts";
import type { LLMConfig, ModelTurn, ToolCall, ToolSpec, WireFormat } from "./types.ts";

// ── neutral conversation ────────────────────────────────────────────────────────

export type ConvItem =
  | { role: "system"; text: string }
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface WireRequest {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
}

const ANTHROPIC_VERSION = "2023-06-01";

function safeJsonParse(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; rawArgs: string } {
  if (typeof raw === "string") return { args: safeJsonParse(raw), rawArgs: raw };
  if (raw && typeof raw === "object") {
    return { args: raw as Record<string, unknown>, rawArgs: JSON.stringify(raw) };
  }
  return { args: {}, rawArgs: "" };
}

// ── OpenAI chat completions (also OpenRouter, Groq, DeepSeek, Mistral, Together, custom) ──

export function openAIMessages(conv: ConvItem[]): unknown[] {
  const out: unknown[] = [];
  for (const item of conv) {
    if (item.role === "system" || item.role === "user") {
      out.push({ role: item.role, content: item.text });
    } else if (item.role === "assistant") {
      const calls = item.toolCalls ?? [];
      if (calls.length === 0) {
        out.push({ role: "assistant", content: item.text });
      } else {
        out.push({
          role: "assistant",
          // Some gateways reject an empty string next to tool_calls; null is the accepted form.
          content: item.text || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.rawArgs || JSON.stringify(c.args) },
          })),
        });
      }
    } else {
      out.push({ role: "tool", tool_call_id: item.toolCallId, content: item.content });
    }
  }
  return out;
}

function openAITools(tools: ToolSpec[]): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function openAIHeaders(cfg: LLMConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  // OpenRouter asks for identifying headers; it uses them for its dashboard only.
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = typeof location === "undefined" ? "https://github.com/geohot0199/ARTEX" : location.origin;
    headers["X-Title"] = "ARTEX Browser";
  }
  return { ...headers, ...(cfg.extraHeaders ?? {}) };
}

// ── Anthropic messages ─────────────────────────────────────────────────────────

export function anthropicPayload(conv: ConvItem[], tools: ToolSpec[], cfg: LLMConfig): Record<string, unknown> {
  const system = conv
    .filter((c) => c.role === "system")
    .map((c) => (c.role === "system" ? c.text : ""))
    .join("\n\n");

  const messages: unknown[] = [];
  for (const item of conv) {
    if (item.role === "system") continue;
    if (item.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: item.text }] });
    } else if (item.role === "assistant") {
      const content: unknown[] = [];
      if (item.text.trim()) content.push({ type: "text", text: item.text });
      for (const c of item.toolCalls ?? []) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      }
      if (content.length === 0) content.push({ type: "text", text: "(no content)" });
      messages.push({ role: "assistant", content });
    } else {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.toolCallId, content: item.content }],
      });
    }
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    messages,
  };
  if (system) body.system = system;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return body;
}

// ── Gemini generateContent ─────────────────────────────────────────────────────

export function geminiPayload(conv: ConvItem[], tools: ToolSpec[], cfg: LLMConfig): Record<string, unknown> {
  const system = conv
    .filter((c) => c.role === "system")
    .map((c) => (c.role === "system" ? c.text : ""))
    .join("\n\n");

  // Gemini alternates user/model turns of parts. Tool results are user-role parts.
  const contents: unknown[] = [];
  const push = (role: "user" | "model", part: unknown) => {
    const last = contents[contents.length - 1] as { role: string; parts: unknown[] } | undefined;
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };

  for (const item of conv) {
    if (item.role === "system") continue;
    if (item.role === "user") push("user", { text: item.text });
    else if (item.role === "assistant") {
      if (item.text.trim()) push("model", { text: item.text });
      for (const c of item.toolCalls ?? []) push("model", { functionCall: { name: c.name, args: c.args } });
    } else {
      push("user", { functionResponse: { name: item.name, response: { result: item.content } } });
    }
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens },
  };
  // The REST API takes camelCase field names here (not the SDK's snake_case).
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  return body;
}

// ── Ollama chat ────────────────────────────────────────────────────────────────

export function ollamaPayload(conv: ConvItem[], tools: ToolSpec[], cfg: LLMConfig): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const item of conv) {
    if (item.role === "system" || item.role === "user") messages.push({ role: item.role, content: item.text });
    else if (item.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: item.text };
      const calls = item.toolCalls ?? [];
      if (calls.length > 0) msg.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
      messages.push(msg);
    } else {
      messages.push({ role: "tool", content: item.content, tool_name: item.name });
    }
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: false,
    options: { temperature: cfg.temperature, num_predict: cfg.maxTokens },
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

// ── request builders ───────────────────────────────────────────────────────────

/** The wire format of a config's provider. */
export function formatFor(cfg: LLMConfig): WireFormat {
  return PROVIDER_BY_ID[cfg.provider]?.format ?? "openai";
}

export function chatRequest(cfg: LLMConfig, conv: ConvItem[], tools: ToolSpec[]): WireRequest {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  switch (formatFor(cfg)) {
    case "openai": {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: openAIMessages(conv),
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
      };
      const t = openAITools(tools);
      if (t) {
        body.tools = t;
        body.tool_choice = "auto";
      }
      return {
        url: `${base}/chat/completions`,
        method: "POST",
        headers: openAIHeaders(cfg),
        body: JSON.stringify(body),
      };
    }
    case "anthropic":
      return {
        url: `${base}/messages`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          // Required for direct browser calls; without it Anthropic rejects the origin.
          "anthropic-dangerous-direct-browser-access": "true",
          ...(cfg.extraHeaders ?? {}),
        },
        body: JSON.stringify(anthropicPayload(conv, tools, cfg)),
      };
    case "gemini":
      return {
        url: `${base}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.extraHeaders ?? {}) },
        body: JSON.stringify(geminiPayload(conv, tools, cfg)),
      };
    case "ollama":
      return {
        url: `${base}/api/chat`,
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.extraHeaders ?? {}) },
        body: JSON.stringify(ollamaPayload(conv, tools, cfg)),
      };
  }
}

// ── response parsers ───────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function parseOpenAI(json: unknown): ModelTurn {
  const root = asRecord(json);
  const choice = asRecord((root.choices as unknown[] | undefined)?.[0]);
  const message = asRecord(choice.message);
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = [];
  for (const raw of (message.tool_calls as unknown[] | undefined) ?? []) {
    const call = asRecord(raw);
    const fn = asRecord(call.function);
    const { args, rawArgs } = parseArgs(fn.arguments);
    toolCalls.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${toolCalls.length}`,
      name: String(fn.name ?? ""),
      args,
      rawArgs,
    });
  }
  const usage = asRecord(root.usage);
  return {
    text,
    toolCalls,
    stopReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
    usage: { input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0) },
  };
}

function parseAnthropic(json: unknown): ModelTurn {
  const root = asRecord(json);
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const raw of (root.content as unknown[] | undefined) ?? []) {
    const block = asRecord(raw);
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? `toolu_${toolCalls.length}`),
        name: String(block.name ?? ""),
        args: asRecord(block.input),
        rawArgs: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = asRecord(root.usage);
  return {
    text,
    toolCalls,
    stopReason: typeof root.stop_reason === "string" ? root.stop_reason : undefined,
    usage: { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0) },
  };
}

function parseGemini(json: unknown): ModelTurn {
  const root = asRecord(json);
  const candidate = asRecord((root.candidates as unknown[] | undefined)?.[0]);
  const content = asRecord(candidate.content);
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const raw of (content.parts as unknown[] | undefined) ?? []) {
    const part = asRecord(raw);
    if (typeof part.text === "string") text += part.text;
    const fc = asRecord(part.functionCall);
    if (fc.name) {
      toolCalls.push({
        id: `gemini_${toolCalls.length}_${String(fc.name)}`,
        name: String(fc.name),
        args: asRecord(fc.args),
        rawArgs: JSON.stringify(fc.args ?? {}),
      });
    }
  }
  const usage = asRecord(root.usageMetadata);
  return {
    text,
    toolCalls,
    stopReason: typeof candidate.finishReason === "string" ? candidate.finishReason : undefined,
    usage: {
      input: Number(usage.promptTokenCount ?? 0),
      output: Number(usage.candidatesTokenCount ?? 0),
    },
  };
}

function parseOllama(json: unknown): ModelTurn {
  const root = asRecord(json);
  const message = asRecord(root.message);
  const toolCalls: ToolCall[] = [];
  for (const raw of (message.tool_calls as unknown[] | undefined) ?? []) {
    const fn = asRecord(asRecord(raw).function);
    toolCalls.push({
      id: `ollama_${toolCalls.length}`,
      name: String(fn.name ?? ""),
      args: asRecord(fn.arguments),
      rawArgs: JSON.stringify(fn.arguments ?? {}),
    });
  }
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    stopReason: typeof root.done_reason === "string" ? root.done_reason : undefined,
    usage: { input: Number(root.prompt_eval_count ?? 0), output: Number(root.eval_count ?? 0) },
  };
}

export function parseChatResponse(format: WireFormat, json: unknown): ModelTurn {
  switch (format) {
    case "openai":
      return parseOpenAI(json);
    case "anthropic":
      return parseAnthropic(json);
    case "gemini":
      return parseGemini(json);
    case "ollama":
      return parseOllama(json);
  }
}

// ── model listing ──────────────────────────────────────────────────────────────

export function modelsRequest(cfg: LLMConfig): WireRequest {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  switch (formatFor(cfg)) {
    case "openai":
      return { url: `${base}/models`, method: "GET", headers: openAIHeaders(cfg) };
    case "anthropic":
      return {
        url: `${base}/models?limit=100`,
        method: "GET",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
          ...(cfg.extraHeaders ?? {}),
        },
      };
    case "gemini":
      return {
        url: `${base}/models?key=${encodeURIComponent(cfg.apiKey)}`,
        method: "GET",
        headers: { ...(cfg.extraHeaders ?? {}) },
      };
    case "ollama":
      return { url: `${base}/api/tags`, method: "GET", headers: { ...(cfg.extraHeaders ?? {}) } };
  }
}

/**
 * Model ids from a /models payload.
 *
 * `accept` filters individual entries (OpenRouter reports per-model capabilities, and a
 * model without tool support cannot run this agent), so it receives the raw entry
 * alongside its id. Everything unreadable is kept: a shorter list is better than an
 * empty one when the payload shape is unexpected.
 */
export function parseModelsResponse(
  format: WireFormat,
  json: unknown,
  accept?: (id: string, entry: unknown) => boolean,
): string[] {
  const root = asRecord(json);
  let ids: string[] = [];
  const list = (root.data as unknown[] | undefined) ?? (root.models as unknown[] | undefined) ?? [];
  for (const raw of list) {
    const m = asRecord(raw);
    const id = m.id ?? m.name ?? m.model;
    if (typeof id !== "string" || !id) continue;
    const clean = id.replace(/^models\//, "");
    if (accept && !accept(clean, raw)) continue;
    ids.push(clean);
  }
  // Gemini marks embedding-only models; they cannot drive the agent.
  if (format === "gemini") {
    ids = ids.filter((id) => !/embedding|aqa/i.test(id));
  }
  return Array.from(new Set(ids)).sort();
}
