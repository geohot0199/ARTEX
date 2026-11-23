// The application store: one hook owning workspace state, the running agent, and the
// side effects of persistence. Views consume it through App.tsx; no view calls fetch.
//
// Design notes
//  * Tasks are immutable snapshots in state; the loop appends events to whichever task is
//    running. Every mutation goes through `updateTask`.
//  * Only one run is active at a time (one AbortController). Pause/stop flips refs the loop
//    polls through shouldContinue, so a pause takes effect at the next boundary.
//  * Approvals block the loop: the tool executor awaits a promise resolved by the UI.

import * as React from "react";

import { runLoop, summarizeAction, isSeverity, clipNote, type LoopEvent } from "../lib/agent.ts";
import { chatCompletion, rawHttp } from "../lib/client.ts";
import {
  DEFAULT_SETTINGS,
  emptyWorkspace,
  hydrateConfig,
  loadSettings,
  loadWorkspace,
  saveApiKey,
  saveSettings,
  saveWorkspace,
  forgetApiKey,
  keyRemembered,
} from "../lib/storage.ts";
import { checkRequestTarget, describeScope, parseScopeItem, scopeAllows } from "../lib/scope.ts";
import type {
  Hypothesis,
  LLMConfig,
  ProviderId,
  Settings,
  Task,
  ToolCall,
  ToolLogEntry,
  TranscriptEntry,
  Workspace,
} from "../lib/types.ts";
import { configForProvider } from "../lib/providers.ts";
import type { ConvItem } from "../lib/wire.ts";

let idSeq = 0;
export function uid(prefix = "id"): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface PendingApproval {
  host: string;
  url: string;
  resolve: (allow: boolean) => void;
}

export interface NewTaskInput {
  name: string;
  goal: string;
  targets: string;
  turnBudget: number;
  requestBudget: number;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  /** id of the created/imported task, when the call created one */
  taskId?: string;
}

export function createTask(input: NewTaskInput): Task {
  const parsed = parseScopeItem(input.targets);
  if (!parsed.ok) throw new Error(parsed.error);
  if (!input.goal.trim()) throw new Error("Describe the goal in a sentence or two.");
  return {
    id: uid("task"),
    name: input.name.trim() || input.targets.trim().split(/[,\s]+/)[0] || "Untitled task",
    goal: input.goal.trim(),
    targets: input.targets.trim().split(/[,\s]+/).filter(Boolean),
    extraScope: parsed.rules,
    turnBudget: Math.max(3, Math.min(200, Math.round(input.turnBudget))),
    requestBudget: Math.max(1, Math.min(500, Math.round(input.requestBudget))),
    status: "idle",
    createdAt: Date.now(),
    turnsUsed: 0,
    requestsUsed: 0,
    tokens: { input: 0, output: 0, calls: 0 },
    findings: [],
    hypotheses: [],
    tools: [],
    transcript: [],
  };
}

export interface WorkspaceApi {
  ws: Workspace;
  settings: Settings;
  llm: LLMConfig | undefined;
  activeTask: Task | undefined;
  running: boolean;
  paused: boolean;
  pendingApproval: PendingApproval | null;
  notice: string | undefined;
  dismissNotice: () => void;
  // setup
  saveLLM: (cfg: LLMConfig, remember: boolean) => void;
  setProvider: (id: ProviderId) => void;
  acceptTerms: () => void;
  forgetKey: () => void;
  remembered: boolean;
  // tasks
  addTask: (input: NewTaskInput) => StartResult;
  startTask: (id: string) => Promise<void>;
  pauseTask: () => void;
  stopTask: () => void;
  selectTask: (id: string | undefined) => void;
  deleteTask: (id: string) => void;
  sendMessage: (taskId: string, text: string) => Promise<void>;
  // approvals / settings
  resolveApproval: (allow: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetAll: () => void;
  exportWorkspace: () => string;
  importWorkspace: (json: string) => StartResult;
}

export function useWorkspace(): WorkspaceApi {
  const [ws, setWs] = React.useState<Workspace>(() => {
    const loaded = loadWorkspace();
    return loaded;
  });
  const [llm, setLlm] = React.useState<LLMConfig | undefined>(() => hydrateConfig(loadWorkspace().llm));
  const [settings, setSettings] = React.useState<Settings>(() => loadSettings());
  const [running, setRunning] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [pendingApproval, setPendingApproval] = React.useState<PendingApproval | null>(null);
  const [notice, setNotice] = React.useState<string | undefined>(undefined);
  const [remembered, setRemembered] = React.useState<boolean>(() => keyRemembered());

  const abortRef = React.useRef<AbortController | null>(null);
  const pausedRef = React.useRef(false);
  const stoppedRef = React.useRef(false);
  const runTaskRef = React.useRef<string | undefined>(undefined);
  const approvalRef = React.useRef<PendingApproval | null>(null);
  const llmRef = React.useRef<LLMConfig | undefined>(llm);
  const settingsRef = React.useRef<Settings>(settings);
  const wsRef = React.useRef<Workspace>(ws);
  const runningRef = React.useRef(false);

  llmRef.current = llm;
  settingsRef.current = settings;
  wsRef.current = ws;
  runningRef.current = running;

  // Persist on every change (cheap: these objects are small at human speed).
  React.useEffect(() => {
    saveWorkspace(ws);
  }, [ws]);
  React.useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const updateTask = React.useCallback((id: string, fn: (t: Task) => Task) => {
    setWs((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? fn(t) : t)),
    }));
  }, []);

  const appendTranscript = React.useCallback(
    (id: string, role: TranscriptEntry["role"], text: string) => {
      updateTask(id, (t) => ({ ...t, transcript: [...t.transcript, { id: uid("tr"), at: Date.now(), role, text }] }));
    },
    [updateTask],
  );

  const activeTask = ws.tasks.find((t) => t.id === ws.activeTaskId);

  // ── setup ─────────────────────────────────────────────────────────────────────

  const saveLLM = React.useCallback((cfg: LLMConfig, remember: boolean) => {
    setLlm(cfg);
    saveApiKey(cfg.apiKey, remember);
    setRemembered(remember);
    setWs((prev) => {
      const clean = { ...cfg, apiKey: "" };
      return { ...prev, llm: clean };
    });
  }, []);

  const setProvider = React.useCallback((id: ProviderId) => {
    setLlm((prev) => configForProvider(id, prev));
  }, []);

  const acceptTerms = React.useCallback(() => {
    setWs((prev) => ({ ...prev, acceptedTerms: true }));
  }, []);

  const forgetKey = React.useCallback(() => {
    forgetApiKey();
    setRemembered(false);
    setLlm((prev) => (prev ? { ...prev, apiKey: "" } : prev));
  }, []);

  // ── approvals ─────────────────────────────────────────────────────────────────

  const resolveApproval = React.useCallback((allow: boolean) => {
    const p = approvalRef.current;
    approvalRef.current = null;
    setPendingApproval(null);
    p?.resolve(allow);
  }, []);

  // ── tool execution ────────────────────────────────────────────────────────────

  const runTool = React.useCallback(
    async (task: Task, call: ToolCall, signal: AbortSignal): Promise<{ ok: boolean; text: string }> => {
      switch (call.name) {
        case "http_request": {
          const target = checkRequestTarget(String(call.args.url ?? ""), task.extraScope, {
            blockPrivate: settingsRef.current.blockPrivateRanges,
          });
          if (!target.ok) return { ok: false, text: `Blocked by scope policy: ${target.reason}` };
          const host = target.url.hostname;
          if (settingsRef.current.approveNewHosts) {
            const known = task.tools.some((t) => t.name === "http_request" && t.target && t.target.includes(host));
            if (!known) {
              const allow = await new Promise<boolean>((resolve) => {
                const p = { host, url: target.url.toString(), resolve };
                approvalRef.current = p;
                setPendingApproval(p);
              });
              if (!allow) return { ok: false, text: `The operator declined the first request to ${host}.` };
            }
          }
          const r = await rawHttp(call.args, signal);
          return { ok: r.ok, text: r.text };
        }
        case "dns_lookup": {
          const name = String(call.args.name ?? "").trim();
          if (!scopeAllows(task.extraScope, name)) return { ok: false, text: `Blocked by scope policy: ${name} is outside the task scope.` };
          const type = String(call.args.type ?? "A").toUpperCase();
          const r = await rawHttp(
            { url: `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, headers: { accept: "application/dns-json" } },
            signal,
          );
          return { ok: r.ok, text: r.text.length > 1200 ? `${r.text.slice(0, 1200)}…` : r.text };
        }
        case "note": {
          const text = clipNote(String(call.args.text ?? ""));
          if (!text) return { ok: false, text: "Empty note ignored." };
          return { ok: true, text: `Noted: ${text}` };
        }
        case "record_finding": {
          const title = String(call.args.title ?? "").trim();
          const severityRaw = String(call.args.severity ?? "").toLowerCase();
          if (!title) return { ok: false, text: "A finding needs a title." };
          if (!isSeverity(severityRaw)) return { ok: false, text: "severity must be critical, high, medium, low or info." };
          return { ok: true, text: `Finding recorded: [${severityRaw}] ${title}` };
        }
        case "report_hypothesis": {
          return { ok: true, text: `Hypothesis tracked: ${String(call.args.text ?? "").slice(0, 120)}` };
        }
        case "finish":
          return { ok: true, text: `Finished: ${String(call.args.summary ?? "")}` };
        default:
          return { ok: false, text: `Unknown tool "${call.name}". Available: http_request, dns_lookup, record_finding, report_hypothesis, note, finish.` };
      }
    },
    [],
  );

  /** Apply a tool's side effects to the task (findings, hypotheses, tools log). */
  const applyToolEvent = React.useCallback(
    (taskId: string, entry: ToolLogEntry, call: ToolCall) => {
      updateTask(taskId, (t) => {
        const now = Date.now();
        let findings = t.findings;
        let hypotheses = t.hypotheses;
        if (call.name === "record_finding" && entry.status === "ok") {
          findings = [
            ...t.findings,
            {
              id: uid("f"),
              title: String(call.args.title ?? "Untitled"),
              severity: String(call.args.severity ?? "info").toLowerCase() as Task["findings"][number]["severity"],
              asset: String(call.args.asset ?? ""),
              evidence: String(call.args.evidence ?? ""),
              remediation: String(call.args.remediation ?? ""),
              createdAt: now,
            },
          ];
        }
        if (call.name === "report_hypothesis" && entry.status === "ok") {
          const text = String(call.args.text ?? "").trim();
          const status = (["untested", "supported", "rejected"] as const).includes(String(call.args.status) as Hypothesis["status"])
            ? (String(call.args.status) as Hypothesis["status"])
            : "untested";
          const existing = t.hypotheses.find((h) => h.text.toLowerCase() === text.toLowerCase());
          if (existing) {
            hypotheses = t.hypotheses.map((h) => (h === existing ? { ...h, status, note: String(call.args.note ?? h.note ?? ""), updatedAt: now } : h));
          } else if (text) {
            hypotheses = [
              ...t.hypotheses,
              { id: uid("h"), text, asset: String(call.args.asset ?? ""), status, note: String(call.args.note ?? ""), createdAt: now, updatedAt: now },
            ];
          }
        }
        return { ...t, findings, hypotheses, tools: [...t.tools, entry] };
      });
    },
    [updateTask],
  );

  // ── the run ───────────────────────────────────────────────────────────────────

  const handleLoopEvent = React.useCallback(
    (taskId: string, e: LoopEvent, currentCall: { call?: ToolCall; startedAt?: number; turn?: number }) => {
      const currentTurn = currentCall.turn ?? 0;
      switch (e.type) {
        case "assistant":
          appendTranscript(taskId, "assistant", e.text);
          break;
        case "tool_start":
          currentCall.call = e.call;
          currentCall.startedAt = Date.now();
          break;
        case "tool_end": {
          const startedAt = currentCall.startedAt ?? Date.now();
          const entry: ToolLogEntry = {
            id: uid("tool"),
            at: startedAt,
            turn: currentTurn,
            name: e.call.name,
            args: e.call.args,
            status: e.ok ? "ok" : "blocked",
            summary: summarizeAction(e.call),
            target: typeof e.call.args.url === "string" ? e.call.args.url : undefined,
            durationMs: Date.now() - startedAt,
          };
          applyToolEvent(taskId, entry, e.call);
          appendTranscript(taskId, "tool", `${summarizeAction(e.call)} → ${e.text.slice(0, 500)}`);
          break;
        }
        case "usage":
          updateTask(taskId, (t) => ({
            ...t,
            tokens: { input: t.tokens.input + e.input, output: t.tokens.output + e.output, calls: t.tokens.calls + 1 },
          }));
          break;
        case "error":
          appendTranscript(taskId, "error", e.message);
          break;
        case "finish":
          updateTask(taskId, (t) => ({ ...t, summary: e.summary }));
          break;
        case "turn_end":
          currentCall.turn = e.turnsUsed;
          updateTask(taskId, (t) => ({ ...t, turnsUsed: e.turnsUsed, requestsUsed: e.requestsUsed }));
          break;
      }
    },
    [appendTranscript, applyToolEvent, updateTask],
  );

  const drive = React.useCallback(
    async (taskId: string) => {
      const task = wsRef.current.tasks.find((t) => t.id === taskId);
      const cfg = llmRef.current;
      if (!task) return;
      if (!cfg) {
        setNotice("Choose a provider and paste a key in Setup before starting a run.");
        return;
      }
      if (!cfg.apiKey && cfg.provider !== "ollama" && cfg.provider !== "custom") {
        setNotice("Paste your API key in Setup before starting a run.");
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      runTaskRef.current = taskId;
      pausedRef.current = false;
      stoppedRef.current = false;
      setRunning(true);
      runningRef.current = true;
      setPaused(false);
      updateTask(taskId, (t) => ({
        ...t,
        status: "running",
        startedAt: t.startedAt ?? Date.now(),
        transcript: [...t.transcript, { id: uid("tr"), at: Date.now(), role: "system", text: `Run started — goal: ${t.goal}` }],
      }));

      const currentCall: { call?: ToolCall; startedAt?: number } = {};
      const notes: string[] = [];
      const recent: string[] = [];

      const loop = await runLoop({
        llm: {
          chat: async (conv: ConvItem[], tools, signal) => {
            const turn = await chatCompletion(cfg, conv, tools, signal);
            return { text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage };
          },
        },
        tools: {
          run: async (call, signal) => {
            const live = wsRef.current.tasks.find((t) => t.id === taskId) ?? task;
            const r = await runTool(live, call, signal);
            recent.push(summarizeAction(call));
            if (call.name === "note" && r.ok) notes.push(clipNote(String(call.args.text ?? "")));
            return r;
          },
        },
        signal: controller.signal,
        history: task.transcript
          .filter((tr) => tr.role === "user" || tr.role === "assistant")
          .slice(-12)
          .map((tr) => ({ role: tr.role === "user" ? "user" : "assistant", text: tr.text })),
        buildContext: (turn) => {
          const live = wsRef.current.tasks.find((t) => t.id === taskId) ?? task;
          return {
            goal: live.goal,
            scopeLines: describeScope(live.extraScope),
            turn,
            turnBudget: live.turnBudget,
            requestsUsed: live.requestsUsed,
            requestBudget: live.requestBudget,
            findings: live.findings,
            recentActions: recent,
            notes,
          };
        },
        shouldContinue: () => !pausedRef.current && !stoppedRef.current,
        onEvent: (e) => handleLoopEvent(taskId, e, currentCall),
        maxTurns: task.turnBudget,
        requestBudget: task.requestBudget,
        requestsUsedBefore: task.requestsUsed,
        turnsUsedBefore: task.turnsUsed,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        turnDelayMs: settingsRef.current.turnDelayMs,
      });

      setRunning(false);
      runningRef.current = false;
      abortRef.current = null;
      runTaskRef.current = undefined;
      updateTask(taskId, (t) => ({
        ...t,
        status: loop === "finished" || loop === "budget" ? "done" : loop === "error" ? "failed" : "stopped",
        endedAt: Date.now(),
        transcript: [
          ...t.transcript,
          {
            id: uid("tr"),
            at: Date.now(),
            role: "system",
            text:
              loop === "finished"
                ? "Run finished."
                : loop === "budget"
                  ? "Budget reached — run wrapped up."
                : loop === "aborted" || loop === "stopped"
                  ? "Run stopped by the operator."
                  : "Run ended with an error (see above).",
          },
        ],
      }));
      if (loop === "finished" && wsRef.current.activeTaskId === taskId) {
        setNotice("Run finished — findings are in the Findings tab.");
      }
    },
    [handleLoopEvent, runTool, updateTask],
  );

  const startTask = React.useCallback(
    async (id: string) => {
      if (runningRef.current) {
        setNotice("A run is already active. Pause or stop it first.");
        return;
      }
      if (!wsRef.current.tasks.some((t) => t.id === id)) return;
      stoppedRef.current = false;
      pausedRef.current = false;
      setWs((prev) => ({ ...prev, activeTaskId: id }));
      await drive(id);
    },
    [drive],
  );

  const pauseTask = React.useCallback(() => {
    if (!running) return;
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      setNotice("Resumed.");
    } else {
      pausedRef.current = true;
      setPaused(true);
      setNotice("Pausing after the current step. Press Pause again to resume.");
    }
  }, [running]);

  const stopTask = React.useCallback(() => {
    stoppedRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    abortRef.current?.abort();
    resolveApproval(false);
  }, [resolveApproval]);

  const addTask = React.useCallback(
    (input: NewTaskInput): StartResult => {
      try {
        const task = createTask(input);
        // Reflect the new list immediately: the caller may start the run in this tick.
        const next = { ...wsRef.current, tasks: [task, ...wsRef.current.tasks], activeTaskId: task.id };
        wsRef.current = next;
        setWs(next);
        return { ok: true, taskId: task.id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  const selectTask = React.useCallback((id: string | undefined) => {
    setWs((prev) => ({ ...prev, activeTaskId: id }));
  }, []);

  const deleteTask = React.useCallback(
    (id: string) => {
      if (runTaskRef.current === id) abortRef.current?.abort();
      setWs((prev) => {
        const tasks = prev.tasks.filter((t) => t.id !== id);
        return { ...prev, tasks, activeTaskId: prev.activeTaskId === id ? tasks[0]?.id : prev.activeTaskId };
      });
    },
    [],
  );

  /** Operator message between runs: appended to transcript; starts a run if idle. */
  const sendMessage = React.useCallback(
    async (taskId: string, text: string) => {
      const body = text.trim();
      if (!body) return;
      appendTranscript(taskId, "user", body);
      if (!running) {
        await startTask(taskId);
      }
    },
    [appendTranscript, running, startTask],
  );

  const updateSettings = React.useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetAll = React.useCallback(() => {
    abortRef.current?.abort();
    const fresh = emptyWorkspace();
    setWs(fresh);
    saveWorkspace(fresh);
    forgetApiKey();
    setLlm(undefined);
    setRemembered(false);
    setSettings({ ...DEFAULT_SETTINGS });
    setNotice("Everything cleared.");
  }, []);

  const exportWorkspace = React.useCallback(() => {
    const exportable = { ...ws, llm: ws.llm ? { ...ws.llm, apiKey: "" } : undefined };
    return JSON.stringify(exportable, null, 2);
  }, [ws]);

  const importWorkspace = React.useCallback((json: string): StartResult => {
    try {
      const parsed = JSON.parse(json) as Workspace;
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return { ok: false, error: "Not an ARTEX Browser workspace export." };
      setWs({ ...parsed, llm: parsed.llm ? { ...parsed.llm, apiKey: llmRef.current?.apiKey ?? "" } : llmRef.current });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON." };
    }
  }, []);

  const dismissNotice = React.useCallback(() => setNotice(undefined), []);

  return {
    ws,
    settings,
    llm,
    activeTask,
    running,
    paused,
    pendingApproval,
    notice,
    dismissNotice,
    saveLLM,
    setProvider,
    acceptTerms,
    forgetKey,
    remembered,
    addTask,
    startTask,
    pauseTask,
    stopTask,
    selectTask,
    deleteTask,
    sendMessage,
    resolveApproval,
    updateSettings,
    resetAll,
    exportWorkspace,
    importWorkspace,
  };
}

