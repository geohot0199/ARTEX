// Network clients: the LLM chat call and the raw HTTP tool.
//
// Both run in the page. Two browser realities are handled here explicitly:
//  * CORS: a fetch that fails with TypeError is almost always a missing CORS header,
//    so it is reported as such instead of "Failed to fetch".
//  * opaqueness: some servers answer without CORS only for "simple" GETs. We always
//    send a normal request and report what the browser lets us read.

import { classifyHttpError, classifyNetworkError } from "./agent.ts";
import { modelSupportsTools } from "./providers.ts";
import type { LLMConfig, ModelTurn, ToolSpec } from "./types.ts";
import {
  chatRequest,
  formatFor,
  modelsRequest,
  parseChatResponse,
  parseModelsResponse,
  type ConvItem,
} from "./wire.ts";

export interface ChatReply extends ModelTurn {}

export function friendlyLlmError(err: unknown, cfg: LLMConfig): string {
  const info = classifyNetworkError(err, cfg.baseUrl || "the configured endpoint");
  return info.message;
}

/**
 * One model call. `signal` aborts the request; the caller maps AbortError to "stopped".
 * Errors are thrown as Error with a user-facing message.
 */
export async function chatCompletion(
  cfg: LLMConfig,
  conv: ConvItem[],
  tools: ToolSpec[],
  signal: AbortSignal,
): Promise<ChatReply & { usage?: { input: number; output: number } }> {
  if (!cfg.baseUrl) throw new Error("No endpoint configured. Open Setup and choose a provider.");
  if (!cfg.model) throw new Error("No model configured. Open Setup and pick a model.");

  const req = chatRequest(cfg, conv, tools);
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal,
      // Never send cookies to a model provider; keys are explicit headers.
      credentials: "omit",
      mode: "cors",
    });
  } catch (err) {
    throw new Error(friendlyLlmError(err, cfg));
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(classifyHttpError(res.status, text).message);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`The provider answered with something that is not JSON (HTTP ${res.status}). First 200 characters: ${text.slice(0, 200)}`);
  }
  const turn = parseChatResponse(formatFor(cfg), json);

  // A model that returns a malformed tool call would loop forever; treat empty names as no call.
  turn.toolCalls = turn.toolCalls.filter((c) => c.name.trim() !== "");
  if (!turn.text && turn.toolCalls.length === 0) {
    const reason = turn.stopReason ? ` (stop reason: ${turn.stopReason})` : "";
    throw new Error(`The model returned an empty response${reason}. If this repeats, try another model or raise the max-tokens limit.`);
  }
  return turn;
}

// ── model listing ──────────────────────────────────────────────────────────────

export async function listModels(cfg: LLMConfig, signal?: AbortSignal): Promise<string[]> {
  const req = modelsRequest(cfg);
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, signal, credentials: "omit", mode: "cors" });
  } catch (err) {
    throw new Error(friendlyLlmError(err, cfg));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(classifyHttpError(res.status, text).message);
  try {
    const json: unknown = JSON.parse(text);
    // Only offer models that can call tools; the rest would fail on the first turn.
    const all = parseModelsResponse(formatFor(cfg), json);
    const usable = parseModelsResponse(formatFor(cfg), json, (_id, entry) => modelSupportsTools(cfg.provider, entry));
    // Fall back to the unfiltered list if filtering removed everything (unknown payload shape).
    return usable.length > 0 ? usable : all;
  } catch {
    throw new Error("Could not parse the model list from this endpoint.");
  }
}

// ── HTTP tool ──────────────────────────────────────────────────────────────────

export interface HttpToolResult {
  ok: boolean;
  text: string;
  status?: number;
  durationMs: number;
}

const BODY_LIMIT = 2400;
const HEADER_KEEP = /^(content-type|server|location|set-cookie|www-authenticate|x-powered-by|allow|x-frame-options|content-security-policy|access-control-allow-origin|strict-transport-security|referrer-policy|x-content-type-options)$/i;

function clipBody(body: string): string {
  if (body.length <= BODY_LIMIT) return body;
  return `${body.slice(0, BODY_LIMIT)}\n…[body truncated, ${body.length - BODY_LIMIT} more characters]`;
}

/**
 * Perform one HTTP request and render a compact, deterministic report for the model.
 *
 * A browser cannot read response headers it was not granted through
 * Access-Control-Expose-Headers, which is why the report says so when headers are thin.
 */
export async function rawHttp(args: Record<string, unknown>, signal: AbortSignal): Promise<HttpToolResult> {
  const url = String(args.url ?? "").trim();
  const method = String(args.method ?? "GET").toUpperCase();
  const headers = (args.headers && typeof args.headers === "object" ? args.headers : {}) as Record<string, unknown>;
  const body = typeof args.body === "string" && args.body.length > 0 ? args.body : undefined;
  const started = performance.now();

  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && v) h.set(k, v);
  }
  // A body with no declared type is the most common source of "why did my POST do nothing".
  if (body && !h.has("content-type")) h.set("content-type", "application/x-www-form-urlencoded");

  let res: Response;
  try {
    res = await fetch(url, { method, headers: h, body, signal, credentials: "omit", mode: "cors", redirect: "follow" });
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, text: "Request aborted by the operator.", durationMs };
    }
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep raw url */
    }
    return {
      ok: false,
      text:
        `The browser could not complete the request to ${host}. Most likely the target does not send CORS headers, ` +
        `so a browser page cannot read its response (the request may still have reached the server). ` +
        `Browsers can only read cross-origin responses that opt in with Access-Control-Allow-Origin. ` +
        `Technical detail: ${err instanceof Error ? err.message : String(err)}`,
      durationMs,
    };
  }

  const durationMs = Math.round(performance.now() - started);
  let text = "";
  if (method !== "HEAD" && res.status !== 204 && res.status !== 304) {
    try {
      text = await res.text();
    } catch {
      text = "(body could not be read)";
    }
  }

  const headerLines: string[] = [];
  res.headers.forEach((value, key) => {
    if (HEADER_KEEP.test(key)) headerLines.push(`${key}: ${value}`);
  });
  const lines = [
    `HTTP ${res.status} ${res.statusText}`.trim(),
    `URL: ${res.url || url}`,
    headerLines.length > 0 ? `Headers:\n${headerLines.map((l) => `  ${l}`).join("\n")}` : "Headers: (none readable — the target does not expose them via CORS)",
    text ? `Body:\n${clipBody(text)}` : "Body: (empty)",
  ];
  return { ok: res.status < 400, text: lines.join("\n"), status: res.status, durationMs };
}
