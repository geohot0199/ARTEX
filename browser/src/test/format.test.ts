import assert from "node:assert/strict";
import test from "node:test";

import { clock, duration, num, shortHost, shortPath, timeAgo, truncate } from "../lib/format.ts";
import {
  configForProvider,
  localhostCaveat,
  maskKey,
  normalizeBaseUrl,
  PROVIDER_BY_ID,
  PROVIDERS,
} from "../lib/providers.ts";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

test("timeAgo picks a natural unit", () => {
  assert.equal(timeAgo(NOW, NOW), "just now");
  assert.equal(timeAgo(NOW - 20_000, NOW), "just now");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(timeAgo(NOW - 3 * 3_600_000, NOW), "3h ago");
  assert.equal(timeAgo(NOW - 24 * 3_600_000, NOW), "yesterday");
  assert.equal(timeAgo(NOW - 6 * 86_400_000, NOW), "6d ago");
  assert.equal(timeAgo(NOW + 60_000, NOW), "just now", "a clock skew never yields a negative age");
});

test("duration stays readable across magnitudes", () => {
  assert.equal(duration(0), "0ms");
  assert.equal(duration(450), "450ms");
  assert.equal(duration(1500), "1.5s");
  assert.equal(duration(65_000), "1m 5s");
  assert.equal(duration(-1), "—");
  assert.equal(duration(Number.NaN), "—");
});

test("truncate only shortens when needed and respects the budget", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 8), "hello w…");
  assert.ok(truncate("x".repeat(100), 10).length <= 10);
});

test("URL helpers degrade gracefully on junk", () => {
  assert.equal(shortHost("https://app.example.com:8443/a/b?c=1"), "app.example.com:8443");
  assert.equal(shortHost("not a url"), "not a url");
  assert.equal(shortPath("https://app.example.com/a/b?c=1"), "/a/b?c=1");
  assert.equal(shortPath("junk"), "junk");
  assert.match(clock(NOW), /^\d{1,2}:\d{2}/);
  assert.equal(num(12345), (12345).toLocaleString());
});

test("every provider preset is internally consistent", () => {
  assert.ok(PROVIDERS.length >= 8);
  for (const preset of PROVIDERS) {
    assert.equal(PROVIDER_BY_ID[preset.id]?.id, preset.id, `${preset.id} is indexed by id`);
    assert.ok(preset.label.length > 0);
    // `custom` is the "bring your own endpoint" escape hatch: the user fills in everything.
    if (preset.id !== "custom") assert.ok(preset.defaultModel.length > 0, `${preset.id} has a default model`);
    assert.equal(preset.baseUrl, preset.baseUrl.replace(/\/+$/, ""), `${preset.id} base URL has no trailing slash`);
    if (preset.id !== "custom") assert.ok(/^https?:\/\//.test(preset.baseUrl), `${preset.id} base URL is absolute`);
    assert.ok(["openai", "anthropic", "gemini", "ollama"].includes(preset.format));
    if (!preset.keyless) assert.ok(preset.keyHint.length > 0, `${preset.id} tells the user where the key goes`);
  }
  // OpenRouter is the recommended default: it is the one that reliably allows browser calls.
  assert.equal(PROVIDER_BY_ID.openrouter?.format, "openai");
  assert.equal(PROVIDER_BY_ID.ollama?.keyless, true);
});

test("configForProvider resets the key when the provider changes but keeps tuning", () => {
  const first = configForProvider("openrouter", { temperature: 0.7, maxTokens: 4096 });
  assert.equal(first.provider, "openrouter");
  assert.equal(first.model, PROVIDER_BY_ID.openrouter?.defaultModel);
  assert.equal(first.apiKey, "");
  assert.equal(first.temperature, 0.7);
  assert.equal(first.maxTokens, 4096);

  const same = configForProvider("openrouter", { provider: "openrouter", apiKey: "sk-kept" });
  assert.equal(same.apiKey, "sk-kept", "re-selecting the same provider keeps the key");

  const switched = configForProvider("groq", { provider: "openrouter", apiKey: "sk-old" });
  assert.equal(switched.apiKey, "", "a key for one provider is never sent to another");
});

test("normalizeBaseUrl accepts real endpoints and rejects nonsense", () => {
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("  http://localhost:11434  "), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("api.openai.com/v1"), "", "a scheme is required");
  assert.equal(normalizeBaseUrl("http://exa mple"), "");
  assert.equal(normalizeBaseUrl(""), "");
});

test("maskKey never reveals more than a stub", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("short"), "•••••");
  const masked = maskKey("sk-proj-abcdefghijklmnop");
  assert.ok(masked.length < "sk-proj-abcdefghijklmnop".length);
  assert.ok(!masked.includes("abcdefghij"));
});

test("localhostCaveat warns only for machine-local endpoints", () => {
  assert.match(localhostCaveat("http://localhost:11434") ?? "", /your own machine/i);
  assert.match(localhostCaveat("http://127.0.0.1:11434") ?? "", /your own machine/i);
  assert.equal(localhostCaveat("https://api.openai.com/v1"), null);
  assert.equal(localhostCaveat("not a url"), null);
});
