// First-run setup: pick a provider, paste a key, say what you are allowed to test.
// Everything here runs in the tab; nothing is sent anywhere except the provider itself.

import * as React from "react";
import { ArrowRight, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import { chatCompletion, listModels } from "../lib/client.ts";
import { PROVIDERS, PROVIDER_BY_ID, localhostCaveat, maskKey, normalizeBaseUrl } from "../lib/providers.ts";
import type { LLMConfig, ProviderId } from "../lib/types.ts";
import { Banner, Chip, Field } from "../components/ui.tsx";
import type { WorkspaceApi } from "../state/useWorkspace.ts";

const STEPS = [
  { n: 1, label: "Pick a provider", detail: "OpenRouter or Groq are the smoothest from a browser — one key, CORS allowed." },
  { n: 2, label: "Paste the key", detail: "It stays in this tab. Never sent to us; only to the provider you chose." },
  { n: 3, label: "Describe the target", detail: "Only hosts you own or have written permission to test." },
];

export function SetupView({ api, onDone }: { api: WorkspaceApi; onDone: () => void }) {
  const cfg = api.llm;
  const provider = cfg?.provider ?? "openrouter";
  const preset = PROVIDER_BY_ID[provider];
  const [showKey, setShowKey] = React.useState(false);
  const [remember, setRemember] = React.useState(api.remembered);
  const [models, setModels] = React.useState<string[]>([]);
  const [modelsError, setModelsError] = React.useState<string | undefined>();
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [check, setCheck] = React.useState<{ ok: boolean; text: string } | undefined>();
  const [advanced, setAdvanced] = React.useState(false);
  const [accepted, setAccepted] = React.useState(api.ws.acceptedTerms);
  const [local, setLocal] = React.useState<LLMConfig>(
    cfg ?? {
      provider,
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
      apiKey: "",
      temperature: 0.2,
      maxTokens: 2048,
    },
  );

  // Keep the local form in sync when the provider changes via the store.
  React.useEffect(() => {
    if (cfg) setLocal(cfg);
  }, [cfg]);

  const patch = (p: Partial<LLMConfig>) => setLocal((prev) => ({ ...prev, ...p }));

  const pickProvider = (id: ProviderId) => {
    api.setProvider(id);
    const p = PROVIDER_BY_ID[id];
    setLocal((prev) => ({ ...prev, provider: id, baseUrl: p.baseUrl, model: p.defaultModel || prev.model, apiKey: id === prev.provider ? prev.apiKey : "" }));
    setModels([]);
    setModelsError(undefined);
    setCheck(undefined);
  };

  const keyNeeded = !preset.keyless;
  const baseValid = normalizeBaseUrl(local.baseUrl) !== "" || preset.keyless;
  const ready = accepted && (!keyNeeded || local.apiKey.trim().length > 6) && local.model.trim().length > 0 && baseValid;

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelsError(undefined);
    try {
      const list = await listModels({ ...local, baseUrl: normalizeBaseUrl(local.baseUrl) || local.baseUrl });
      setModels(list);
      if (list.length === 0) setModelsError("The provider returned an empty model list. Type the model name by hand.");
      if (!list.includes(local.model) && list.length > 0 && !local.model) patch({ model: list[0] });
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  };

  const testConnection = async () => {
    setChecking(true);
    setCheck(undefined);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45_000);
      const turn = await chatCompletion(
        { ...local, baseUrl: normalizeBaseUrl(local.baseUrl) || local.baseUrl },
        [{ role: "system", text: "Reply with exactly: ok" }, { role: "user", text: "ping" }],
        [],
        ctrl.signal,
      );
      clearTimeout(t);
      setCheck({ ok: true, text: `The model answered. Keys and endpoint work. Reply: ${(turn.text || "(tool call)").slice(0, 80)}` });
    } catch (err) {
      setCheck({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  };

  const save = () => {
    api.saveLLM({ ...local, baseUrl: normalizeBaseUrl(local.baseUrl) || local.baseUrl }, remember);
    if (accepted) api.acceptTerms();
    onDone();
  };

  const caveat = local.baseUrl ? localhostCaveat(normalizeBaseUrl(local.baseUrl) || local.baseUrl) : null;

  return (
    <div className="setup">
      <div className="hero">
        <img src="logo.svg" alt="ARTEX" />
        <h1>ARTEX, in your browser</h1>
        <p>
          The autonomous pentest loop — planner, workers, findings, evidence — running entirely in this tab.
          No install, no database, no server. Paste an LLM key and go.
        </p>
      </div>

      <div className="card card-pad grid" style={{ gap: 8 }}>
        {STEPS.map((s) => (
          <div className="step" key={s.n}>
            <Chip tone="brand">{s.n}</Chip>
            <span>
              <b>{s.label}</b> — {s.detail}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <KeyRound size={15} className="muted" />
          <h3>1 · LLM provider</h3>
          <div className="spacer" />
          {preset.keyUrl && (
            <a className="btn sm ghost" href={preset.keyUrl} target="_blank" rel="noreferrer noopener">
              Get a key <ExternalLink size={12} />
            </a>
          )}
        </div>
        <div className="card-pad grid" style={{ gap: 14 }}>
          <div className="provider-grid">
            {PROVIDERS.map((p) => (
              <button key={p.id} className={`provider ${p.id === provider ? "active" : ""}`} onClick={() => pickProvider(p.id)} type="button">
                <span className="p-name">{p.label}</span>
                <span className="p-note">{p.keyless ? "no key" : p.id === "openrouter" || p.id === "groq" || p.id === "mistral" ? "CORS-friendly" : "may need proxy"}</span>
              </button>
            ))}
          </div>

          {preset.note && (
            <div className={`banner ${provider === "openrouter" || provider === "groq" || provider === "mistral" || provider === "gemini" ? "ok" : "warn"}`}>
              <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{preset.note}</span>
            </div>
          )}

          <div className="grid grid-2">
            <Field label="API key" help={preset.keyless ? "This provider does not need a key." : `Looks like ${preset.keyHint}. Stored ${remember ? "in this browser (persistent)" : "only for this tab"}.`}>
              <div className="row">
                <input
                  type={showKey ? "text" : "password"}
                  value={local.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value.trim() })}
                  placeholder={preset.keyless ? "(not needed)" : preset.keyHint}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={preset.keyless}
                />
                <button className="btn sm" type="button" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "Hide key" : "Show key"}>
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Field>
            <Field
              label="Model"
              help={
                modelsError ? (
                  <span style={{ color: "var(--warn)" }}>{modelsError}</span>
                ) : models.length > 0 ? (
                  `${models.length} models available`
                ) : (
                  "Type it, or load the provider's list."
                )
              }
            >
              <div className="row">
                <input
                  list="model-options"
                  value={local.model}
                  onChange={(e) => patch({ model: e.target.value })}
                  placeholder={preset.defaultModel || "model name"}
                  spellCheck={false}
                />
                <datalist id="model-options">
                  {models.length > 0
                    ? models.map((m) => <option key={m} value={m} />)
                    : preset.modelSuggestions.map((m) => <option key={m} value={m} />)}
                </datalist>
                <button className="btn sm" type="button" onClick={fetchModels} disabled={loadingModels || (!local.apiKey && !preset.keyless)}>
                  {loadingModels ? <Loader2 size={14} className="spin" /> : "List"}
                </button>
              </div>
            </Field>
          </div>

          <label className="checkline">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>
              Remember this key in this browser. Off by default: the key then lives only in this tab and disappears when it closes.
              Any script on this origin can read stored keys, so use a dedicated, low-limit key.
            </span>
          </label>

          <div className="row wrap">
            <button className="btn" onClick={() => setAdvanced((v) => !v)} type="button">
              {advanced ? "Hide advanced" : "Advanced"} <ArrowRight size={13} style={{ transform: advanced ? "rotate(90deg)" : "none", transition: "120ms" }} />
            </button>
            <button
              className="btn"
              type="button"
              onClick={testConnection}
              disabled={checking || (!local.apiKey && !preset.keyless) || !local.model || !baseValid}
            >
              {checking ? <Loader2 size={14} /> : <CheckCircle2 size={14} />} Test connection
            </button>
            <div className="spacer" />
            {local.apiKey && <Chip>{maskKey(local.apiKey)}</Chip>}
          </div>

          {advanced && (
            <div className="grid grid-2">
              <Field label="Base URL" help="Change only for a gateway or a local server.">
                <input value={local.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} spellCheck={false} placeholder="https://…" />
              </Field>
              <Field label="Max output tokens" help="Per reply. 2048 is plenty for one step.">
                <input
                  type="number"
                  min={256}
                  max={16000}
                  step={256}
                  value={local.maxTokens}
                  onChange={(e) => patch({ maxTokens: Number(e.target.value) || 2048 })}
                />
              </Field>
              <Field label="Temperature" help="0 is focused; 0.7 is adventurous.">
                <input
                  type="number"
                  min={0}
                  max={1.5}
                  step={0.1}
                  value={local.temperature}
                  onChange={(e) => patch({ temperature: Number(e.target.value) })}
                />
              </Field>
            </div>
          )}

          {check && (
            <Banner tone={check.ok ? "ok" : "bad"}>
              {check.ok ? <CheckCircle2 size={15} style={{ marginRight: 6, verticalAlign: -2 }} /> : <TriangleAlert size={15} style={{ marginRight: 6, verticalAlign: -2 }} />}
              {check.text}
            </Banner>
          )}
          {caveat && (
            <Banner tone="warn">
              <TriangleAlert size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
              {caveat}
            </Banner>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <ShieldCheck size={15} className="muted" />
          <h3>2 · Authorised use</h3>
        </div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <p className="small muted">
            ARTEX Browser sends real HTTP requests to real systems. Testing a system you do not own or have written
            permission to test is illegal in most jurisdictions, including under the Computer Fraud and Abuse Act and the
            Indian IT Act. You are the operator; the responsibility is yours.
          </p>
          <p className="small muted">
            Scope is enforced in the harness: a request to a host outside the task scope is blocked before it leaves the tab.
            Findings are recorded with the evidence that produced them, so a run can be reviewed afterwards.
          </p>
          <label className="checkline">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>I will only test systems I own or have explicit written permission to test, and I understand requests come from my own browser and IP address.</span>
          </label>
        </div>
      </div>

      <div className="row">
        <div className="small faint">
          {!accepted ? "Tick the authorisation box to continue." : !local.model ? "Choose a model." : keyNeeded && local.apiKey.trim().length <= 6 ? "Paste your API key." : "Ready."}
        </div>
        <div className="spacer" />
        <button className="btn primary" disabled={!ready} onClick={save}>
          Save and start <ArrowRight size={15} />
        </button>
      </div>

      <p className="tiny faint" style={{ textAlign: "center", paddingBottom: 24 }}>
        ARTEX Browser is the frontend of{" "}
        <a href="https://github.com/geohot0199/ARTEX" target="_blank" rel="noreferrer noopener">
          geohot0199/ARTEX
        </a>{" "}
        reshaped to run without a backend. For asset graphs, traffic capture and interception, use the full self-hosted install.
      </p>
    </div>
  );
}
