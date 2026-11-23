// ARTEX Browser — domain model.
// Mirrors the shapes of the full ARTEX install (web/src/lib/types.ts) closely enough
// that the same mental model applies, but trimmed to what a browser-only run needs.

export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "mistral"
  | "together"
  | "ollama"
  | "custom";

export type WireFormat = "openai" | "anthropic" | "gemini" | "ollama";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  format: WireFormat;
  baseUrl: string;
  defaultModel: string;
  modelSuggestions: string[];
  keyHint: string;
  keyUrl?: string;
  /** Shown in the setup card: what the browser will talk to, and CORS caveats. */
  note?: string;
  /** Ollama and other keyless local servers. */
  keyless?: boolean;
}

export interface LLMConfig {
  provider: ProviderId;
  /** Fixed for a preset but editable in the advanced section. No trailing slash. */
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** Some gateways need extra headers (e.g. OpenRouter's referer). Optional. */
  extraHeaders?: Record<string, string>;
}

// ── chat wire types ──────────────────────────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON object; `{}` when the model emitted invalid/empty arguments. */
  args: Record<string, unknown>;
  /** Raw argument text, kept so invalid JSON can be reported back to the model. */
  rawArgs: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
  /** Provider stop reason, if it reported one. */
  stopReason?: string;
}

// ── agent / findings ────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  asset: string;
  evidence: string;
  remediation: string;
  createdAt: number;
}

export type HypothesisStatus = "untested" | "supported" | "rejected";

export interface Hypothesis {
  id: string;
  text: string;
  asset: string;
  status: HypothesisStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export type ToolName = "http_request" | "dns_lookup" | "record_finding" | "note" | "report_hypothesis" | "finish";

export interface ToolLogEntry {
  id: string;
  at: number;
  /** The model turn that issued this call (1-based). */
  turn: number;
  name: ToolName | string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error" | "blocked";
  summary: string;
  /** Request line / command form, when there is one. */
  target?: string;
  durationMs?: number;
}

export interface TranscriptEntry {
  id: string;
  at: number;
  role: "system" | "assistant" | "user" | "tool" | "error";
  text: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  calls: number;
}

export type TaskStatus = "idle" | "running" | "paused" | "done" | "failed" | "stopped";

export interface ScopeRule {
  /** Exactly one of host/domain/cidr is set. `wildcard` qualifies a `host` rule. */
  host?: string;
  /** `*.example.com`: subdomains only, not the apex. */
  wildcard?: boolean;
  /** `example.com`: the apex plus every subdomain. */
  domain?: string;
  cidr?: string;
  /** Raw text, for display. */
  raw: string;
}

export interface Task {
  id: string;
  name: string;
  goal: string;
  targets: string[];
  /** Extra scope text supplied by the user, merged with parsed targets. */
  extraScope: ScopeRule[];
  /** Hard cap on model turns; the planner is told to wrap up before this. */
  turnBudget: number;
  requestBudget: number;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  turnsUsed: number;
  requestsUsed: number;
  tokens: TokenUsage;
  findings: Finding[];
  hypotheses: Hypothesis[];
  tools: ToolLogEntry[];
  transcript: TranscriptEntry[];
  summary?: string;
}

/** Everything persisted in localStorage. The API key is stored separately. */
export interface Workspace {
  version: 1;
  tasks: Task[];
  activeTaskId?: string;
  llm?: LLMConfig;
  /** User accepted the authorised-use notice. */
  acceptedTerms: boolean;
  createdAt: number;
}

export interface Settings {
  /** Delay between turns keeps a runaway loop from hammering the provider. */
  turnDelayMs: number;
  /** Refuse requests to hosts that resolve to private IPs. */
  blockPrivateRanges: boolean;
  /** Ask before the first request to each new host. */
  approveNewHosts: boolean;
}
