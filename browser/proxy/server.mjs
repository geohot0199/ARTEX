#!/usr/bin/env node
// Optional, dependency-free proxy for providers that refuse direct browser calls.
//
//   node browser/proxy/server.mjs            # listens on http://localhost:8787
//   PORT=9000 node browser/proxy/server.mjs
//
// Why it exists: api.openai.com and api.anthropic.com do not send CORS headers, so a page
// cannot read their replies. OpenRouter, Groq, Gemini, Mistral, Together and a local Ollama
// work directly — use this only if you specifically need OpenAI or Anthropic.
//
// It is a *local development* helper, not a hosted service: it forwards your own key from
// your own browser, stores nothing, and only ever talks to the two hosts below.
//
// Use it from the app as a Custom (OpenAI-compatible) provider:
//   base URL  http://localhost:8787/openai      (→ https://api.openai.com/v1/…)
//   base URL  http://localhost:8787/anthropic   (→ https://api.anthropic.com/v1/…)
//   (note: the browser app is served over http://localhost too, so no mixed-content block)

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

/** Only these upstreams are reachable, so this cannot become an open relay. */
const ROUTES = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "86400",
};

function fail(res, status, message) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const [, prefix = "", ...rest] = url.pathname.split("/");
  const upstreamBase = ROUTES[prefix];
  if (!upstreamBase) {
    fail(
      res,
      404,
      `Unknown route "/${prefix}". Use /openai or /anthropic (available: ${Object.keys(ROUTES).join(", ")}).`,
    );
    return;
  }

  const target = `${upstreamBase}/${rest.join("/")}${url.search}`;
  const headers = { ...req.headers };
  // Hop-by-hop and browser-origin headers must not be forwarded verbatim.
  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;
  delete headers.cookie;
  // Anthropic requires this for non-server callers; harmless for OpenAI-style routes.
  if (prefix === "anthropic") headers["anthropic-dangerous-direct-browser-access"] = "true";

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
  } catch (err) {
    fail(res, 502, `Could not reach the upstream: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const outHeaders = { ...CORS };
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) outHeaders[name] = value;
  }
  res.writeHead(upstream.status, outHeaders);
  // Stream it back so long model replies arrive as they are produced.
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`ARTEX browser proxy listening on http://${HOST}:${PORT}`);
  console.log(`  /openai    → ${ROUTES.openai}`);
  console.log(`  /anthropic → ${ROUTES.anthropic}`);
  console.log("Keep this terminal open while you use the app. Ctrl-C to stop.");
});
