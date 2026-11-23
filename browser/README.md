# ARTEX Browser

**The autonomous pentest loop with zero installation.** Open a page, paste an LLM API key, name a target
you are authorised to test, and watch the agent plan, send requests, and write findings.

This is a standalone, fully static edition of [ARTEX](../README.md). There is no Go server, no PostgreSQL,
no Docker Compose, no setup token to dig out of container logs, and no build step for the user. Everything
runs in the browser tab: the agent loop, the scope gate, the HTTP tool, findings, and persistence.

```bash
cd browser
npm install      # only for developing this folder
npm run dev      # http://localhost:5173
```

Or build once and host the result anywhere static:

```bash
npm run build    # → dist/
```

`dist/` can be dropped on GitHub Pages, Netlify, S3, Cloudflare Pages, or opened through any static file
server. There is no backend to deploy alongside it.

---

## First run: paste a key, start a task

1. **Setup** — pick a provider (OpenRouter is preselected and is the one that works most reliably from a
   browser), paste your API key, and press **Test connection**. The model dropdown is filled from the
   provider's own `/models` endpoint, so you can see what your key can actually reach.
2. Tick the authorised-use notice. This is a real gate: the app will not run a task without it.
3. **New task** — give it a name, a goal in plain English, and your targets. The scope box accepts hosts,
   domains, wildcards and CIDR ranges:
   - `app.example.com` — that host **and its subdomains**
   - `*.example.com` — every subdomain, not the apex
   - `example.com` — the apex and every subdomain
   - `10.0.0.0/24`, `192.168.1.10` — CIDR / single address
   A pasted URL is reduced to its host.
4. Press **Create & start**. The agent calls your provider, chooses tools, and streams its actions into the
   Run panel: **Trace**, **Tool calls**, **Findings**, **Hypotheses**, **Scope**.

You can pause, stop, or resume a run, and chat with it mid-run from the message bar.

### Where the key lives

- By default the key goes into **`sessionStorage`**: it disappears when the tab closes, and it is never
  written into the exported workspace file.
- **"Remember this key"** moves it to `localStorage` so a reload does not ask again. The Setup screen says
  so plainly, because any script on that origin could read it.
- **Forget key** (Setup or Settings) wipes both copies.
- Requests go straight from your browser to the provider. There is no ARTEX server in the middle, which is
  also why the key never leaves your machine.

---

## What the agent can actually do in a browser

| Tool | Runs in the page | Notes |
| --- | --- | --- |
| `http_request` | ✅ | Any method, scope-gated, response headers and a clipped body |
| `dns_lookup` | ✅ | Via DNS-over-HTTPS (`cloudflare-dns.com`), so it is not a local resolver |
| `record_finding` / `report_hypothesis` / `note` | ✅ | Written into the task, shown in the UI |
| `finish` | ✅ | Ends the run with a summary |
| bash, nmap, sqlmap, nuclei, a MITM proxy | ❌ | Genuinely impossible from a web page — a browser cannot spawn processes |

So this edition is honest about its ceiling: it does HTTP-level testing, it does not replace a full ARTEX
install. If you need the scanner suite, proxy capture, or the PostgreSQL-backed knowledge graph, use the
main install — and the *same* mental model (tasks, findings, assets, scope, budgets) carries over.

### The CORS wall (read this if "Test connection" fails)

A web page can only read a response from a server that sends `Access-Control-Allow-Origin`. That is a
browser rule, not an ARTEX setting.

| Provider | Direct from the browser |
| --- | --- |
| OpenRouter, Groq, Gemini, Mistral, Together, DeepSeek | ✅ Works |
| Ollama (local) | ✅ With `OLLAMA_ORIGINS=*` in the environment before `ollama serve` |
| OpenAI (`api.openai.com`) | ❌ No CORS headers → use the proxy below, or use OpenRouter |
| Anthropic (`api.anthropic.com`) | ❌ No CORS headers → use the proxy below |

Two more practical limits:

- **Mixed content.** A page served over `https://` cannot call `http://localhost`. If you point ARTEX at
  a local model, run the app with `npm run dev` / `npm run preview` (plain http) rather than from an https host.
- **Response headers are partially readable.** Targets rarely list `Access-Control-Expose-Headers`, so the
  agent may see a status and body but few headers. The tool report says when that is the case instead of
  pretending the header was missing server-side.

### Optional proxy for OpenAI / Anthropic

If you specifically want those two providers, run the tiny included proxy (Node 22+, no dependencies):

```bash
node proxy/server.mjs          # http://localhost:8787
```

Then in **Setup → Custom OpenAI-compatible** (or Advanced):

- base URL `http://localhost:8787/openai` → forwards to `https://api.openai.com/v1`
- base URL `http://localhost:8787/anthropic` → forwards to `https://api.anthropic.com/v1`

It only forwards to those two upstream hosts, adds the CORS headers, and stores nothing. Note that using
it means your key now travels through a local process — which is exactly the thing the direct-to-provider
path avoids.

---

## Safety model

- **Scope gate.** Every URL the model proposes is checked against the task's rules before the request is
  made. Out-of-scope hosts are refused and the refusal is shown to the model and to you.
- **Advisory, not jail-proof.** The gate runs in your browser, so a determined human with devtools can
  bypass it. It exists to keep an honest run honest — it is not a sandbox against the operator.
- **Approval gate.** Settings can require a click before the first request to each new host.
- **Private ranges.** Settings can refuse requests to loopback/RFC1918/link-local literals.
- **Budgets.** Turn and request caps are hard limits; the request budget is checked per request, so a model
  asking for five URLs at once cannot overshoot it.
- **Non-destructive prompt.** The system prompt forbids destructive testing, brute force, persistence and
  mass scanning, and demands evidence for every finding.

Only test systems you are authorised to test.

---

## Persistence and portability

- Workspace (`tasks`, findings, transcript, tool log, LLM config **without** the key) → `localStorage`.
- Settings → `localStorage`.
- API key → `sessionStorage`, or `localStorage` if you opted in.
- **Export** in Settings writes the whole workspace as JSON with the key redacted; **Import** restores it.
  Findings can also be exported as Markdown or JSON for a report.

Storage-blocked environments (private windows, hardened browsers) degrade to in-memory: the app keeps
working, it just forgets on reload.

---

## Development

```bash
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm test            # node --test with native TS type stripping (no test dependencies)
npm run build       # vite build → dist/
npm run verify      # all three, in that order
```

Layout:

```
src/lib/types.ts        domain model (tasks, findings, hypotheses, scope, settings)
src/lib/providers.ts    the 10 provider presets, CORS notes, key masking
src/lib/wire.ts         pure request builders / response parsers for the 4 wire formats
src/lib/scope.ts        host / wildcard / CIDR parsing and the request-target policy
src/lib/agent.ts        the agent loop, tool specs, system prompt, error classification
src/lib/client.ts       fetch wrappers (chat, model listing, the HTTP tool)
src/lib/storage.ts      persistence, key handling, redaction
src/state/useWorkspace.ts   the one stateful hook: tasks, run control, tool executor
src/views/              Setup, New task, Tasks + Run panel, Findings, Settings, Approval
src/test/               unit tests (scope, wire, agent loop, storage, format/providers)
proxy/server.mjs        optional local proxy for OpenAI / Anthropic
```

The loop is transport-injected, so the agent tests drive it with a scripted model and a fake tool runner —
no network, no browser, deterministic.

`BROWSER_BASE=/ARTEX/ npm run build` sets the public path for sub-directory hosting (e.g. GitHub Pages).

## Licence

AGPL-3.0-or-later, same as ARTEX.
