// Persistence.
//
// Two buckets, on purpose:
//  * "artex-browser.workspace" — tasks, findings, transcript, LLM settings (no key).
//  * "artex-browser.session"   — the API key, in sessionStorage, so it disappears when
//    the tab closes. "Remember key" moves it to localStorage and the UI says so plainly.
//
// This is a single-user, client-side tool: anything in localStorage is readable by any
// script running on the same origin. The UI says this instead of pretending otherwise.

import type { LLMConfig, Settings, Workspace } from "./types.ts";

export const WORKSPACE_KEY = "artex-browser.workspace";
export const SESSION_KEY_KEY = "artex-browser.session.key";
export const REMEMBER_KEY_KEY = "artex-browser.session.remember";
export const SETTINGS_KEY = "artex-browser.settings";

export const DEFAULT_SETTINGS: Settings = {
  turnDelayMs: 400,
  blockPrivateRanges: false,
  approveNewHosts: false,
};

function safeGet(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(store: Storage | undefined, key: string, value: string | null): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // Storage full or blocked (private mode). The app keeps working in memory.
  }
}

export function emptyWorkspace(): Workspace {
  return { version: 1, tasks: [], acceptedTerms: false, createdAt: Date.now() };
}

/** Tolerant load: a corrupt or older blob yields an empty workspace rather than a crash. */
export function loadWorkspace(store: Storage | undefined = globalThis.localStorage): Workspace {
  const raw = safeGet(store, WORKSPACE_KEY);
  if (!raw) return emptyWorkspace();
  try {
    const parsed = JSON.parse(raw) as Partial<Workspace>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return emptyWorkspace();
    return {
      version: 1,
      tasks: parsed.tasks.filter((t) => t && typeof t.id === "string"),
      activeTaskId: typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : undefined,
      llm: parsed.llm && typeof parsed.llm === "object" ? parsed.llm : undefined,
      acceptedTerms: parsed.acceptedTerms === true,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return emptyWorkspace();
  }
}

/** Strip the key before writing the workspace, whatever the caller handed us. */
export function saveWorkspace(ws: Workspace, store: Storage | undefined = globalThis.localStorage): void {
  const llm = ws.llm ? { ...ws.llm, apiKey: "" } : undefined;
  safeSet(store, WORKSPACE_KEY, JSON.stringify({ ...ws, llm }));
}

export function loadSettings(store: Storage | undefined = globalThis.localStorage): Settings {
  const raw = safeGet(store, SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      turnDelayMs: typeof p.turnDelayMs === "number" ? Math.max(0, Math.min(5000, p.turnDelayMs)) : DEFAULT_SETTINGS.turnDelayMs,
      blockPrivateRanges: p.blockPrivateRanges === true,
      approveNewHosts: p.approveNewHosts === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings, store: Storage | undefined = globalThis.localStorage): void {
  safeSet(store, SETTINGS_KEY, JSON.stringify(s));
}

export function loadApiKey(): string {
  return safeGet(globalThis.localStorage, SESSION_KEY_KEY) ?? safeGet(globalThis.sessionStorage, SESSION_KEY_KEY) ?? "";
}

export function saveApiKey(key: string, remember: boolean): void {
  safeSet(globalThis.localStorage, SESSION_KEY_KEY, remember ? key : null);
  safeSet(globalThis.sessionStorage, SESSION_KEY_KEY, key || null);
  safeSet(globalThis.localStorage, REMEMBER_KEY_KEY, remember ? "1" : null);
}

export function keyRemembered(): boolean {
  return safeGet(globalThis.localStorage, REMEMBER_KEY_KEY) === "1";
}

export function forgetApiKey(): void {
  safeSet(globalThis.localStorage, SESSION_KEY_KEY, null);
  safeSet(globalThis.sessionStorage, SESSION_KEY_KEY, null);
  safeSet(globalThis.localStorage, REMEMBER_KEY_KEY, null);
}

/** Drop the key from a config before it is written anywhere that is exported or displayed. */
export function redactConfig(cfg: LLMConfig | undefined): LLMConfig | undefined {
  return cfg ? { ...cfg, apiKey: cfg.apiKey ? "••••••••" : "" } : undefined;
}

/** A redacted key ("••••••••") is a placeholder, never a credential. */
function isMaskedKey(value: string): boolean {
  return value.length > 0 && /^[•*\s]+$/.test(value);
}

/** Merge a loaded config with the separately stored key. */
export function hydrateConfig(cfg: LLMConfig | undefined): LLMConfig | undefined {
  if (!cfg) return undefined;
  if (isMaskedKey(cfg.apiKey)) return { ...cfg, apiKey: loadApiKey() };
  return { ...cfg, apiKey: cfg.apiKey || loadApiKey() };
}
