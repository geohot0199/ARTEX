// Provider presets and CORS notes.
//
// The browser edition calls the model provider directly from the page — there is no
// server to hide behind. Every request therefore needs the provider (or a gateway) to
// answer CORS preflights. The fast path is a key provider that allows browser origins
// (OpenRouter, Groq, Gemini and most OpenAI-compatible gateways). Providers that do
// not send CORS headers can still be used through the optional serverless proxy in
// browser/proxy/ — see "CORS & the optional proxy" in browser/README.md.

import type { LLMConfig, ProviderId, ProviderPreset } from "./types.ts";

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    // A tool-calling model is mandatory: without tool calls the agent cannot act.
    defaultModel: "openai/gpt-oss-120b",
    modelSuggestions: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b:free",
      "deepseek/deepseek-chat-v3-0324",
      "qwen/qwen3-coder",
      "google/gemini-2.5-flash",
    ],
    keyHint: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/keys",
    note: "One key for hundreds of models. Sends CORS headers, so it works straight from the page. Pick a model that supports tool calling (the defaults do).",
  },
  {
    id: "openai",
    label: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    modelSuggestions: ["gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    keyHint: "sk-proj-…",
    keyUrl: "https://platform.openai.com/api-keys",
    note: "api.openai.com does not send CORS headers, so a direct call from the page is usually blocked. Use OpenRouter (below) or the optional proxy.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    format: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    modelSuggestions: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "api.anthropic.com does not send CORS headers. Use OpenRouter or the optional proxy.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    modelSuggestions: ["gemini-2.5-flash", "gemini-2.5-pro"],
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Generous free tier. The key travels as a query parameter (Google's scheme); the model list is fetched live.",
  },
  {
    id: "groq",
    label: "Groq",
    format: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    modelSuggestions: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3-32b"],
    keyHint: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    note: "Very fast, free tier, CORS-friendly. A good first choice if you already have a Groq key.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    format: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    modelSuggestions: ["deepseek-chat", "deepseek-reasoner"],
    keyHint: "sk-…",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    format: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    modelSuggestions: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    keyHint: "…",
    keyUrl: "https://console.mistral.ai/api-keys",
    note: "Sends CORS headers; usable directly from the page.",
  },
  {
    id: "together",
    label: "Together AI",
    format: "openai",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    modelSuggestions: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    keyHint: "…",
    keyUrl: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    format: "ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: "llama3.2",
    modelSuggestions: ["llama3.2", "qwen2.5-coder", "mistral"],
    keyHint: "no key needed",
    note: "Runs on your own machine. Start Ollama with OLLAMA_ORIGINS=* so the browser is allowed to call it.",
    keyless: true,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    format: "openai",
    baseUrl: "",
    defaultModel: "",
    modelSuggestions: [],
    keyHint: "any",
    note: "Any /chat/completions endpoint (vLLM, LiteLLM, LM Studio, a company gateway). It must answer CORS preflights.",
  },
];

/**
 * Can this model drive the agent? Every tool in ARTEX is a function call, so a model
 * without tool support cannot run a task. OpenRouter advertises this per model; other
 * providers are not filtered (their lists are small or already curated).
 */
export function modelSupportsTools(provider: ProviderId, raw: unknown): boolean {
  if (provider !== "openrouter") return true;
  if (!raw || typeof raw !== "object") return true;
  const entry = raw as { supported_parameters?: unknown; architecture?: { input_modalities?: unknown } };
  const params = entry.supported_parameters;
  if (Array.isArray(params)) {
    const names = params.filter((p): p is string => typeof p === "string");
    if (names.length > 0) return names.includes("tools") || names.includes("tool_choice");
  }
  return true;
}

export const PROVIDER_BY_ID: Record<ProviderId, ProviderPreset> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
) as Record<ProviderId, ProviderPreset>;

/** New config for a provider, used when the provider changes in the setup screen. */
export function configForProvider(id: ProviderId, previous?: Partial<LLMConfig>): LLMConfig {
  const preset = PROVIDER_BY_ID[id];
  return {
    provider: id,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    // Re-selecting the same provider keeps the key; a known switch never carries a key over.
    apiKey: previous?.provider && previous.provider !== id ? "" : (previous?.apiKey ?? ""),
    temperature: previous?.temperature ?? 0.2,
    maxTokens: previous?.maxTokens ?? 2048,
  };
}

/**
 * Normalise a user-entered base URL: trim, drop trailing slashes, and reject anything
 * that is not http(s). Returns "" for unusable input so the caller can show a message.
 */
export function normalizeBaseUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) return "";
  try {
    // Throws on malformed input such as "http://exa mple".
    new URL(v);
  } catch {
    return "";
  }
  return v;
}

/**
 * Redact a key for display and logs. Keeps enough to recognise the key, never enough
 * to use it. Short keys are fully hidden.
 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 10) return "•".repeat(k.length);
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

/** A warning string when the target host is one the browser cannot talk to. */
export function localhostCaveat(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "This endpoint is on your own machine. A browser page served over HTTPS (e.g. GitHub Pages) will block plain-http localhost calls; run the app from a local server (npm run dev / npm run preview) instead.";
    }
  } catch {
    /* invalid URL is handled elsewhere */
  }
  return null;
}
