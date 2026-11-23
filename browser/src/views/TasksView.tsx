// Task list + the run console for the selected task.

import * as React from "react";
import {
  Activity,
  CircleStop,
  Pause,
  Play,
  Plus,
  Receipt,
  SendHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { describeScope } from "../lib/scope.ts";
import { clock, duration, num, timeAgo } from "../lib/format.ts";
import type { Task } from "../lib/types.ts";
import { Banner, Card, CardHead, Chip, Empty, Severity, StatusDot, Tabs } from "../components/ui.tsx";
import type { WorkspaceApi } from "../state/useWorkspace.ts";

export function TasksView({
  api,
  onNew,
}: {
  api: WorkspaceApi;
  onNew: () => void;
  onEditTask: (id: string) => void;
  editingTaskId?: string;
  clearEditing: () => void;
}) {
  const { ws } = api;
  if (ws.tasks.length === 0) {
    return (
      <Card className="card-pad">
        <Empty icon={<Activity size={28} />} title="No tasks yet">
          A task is one goal plus the hosts it may touch. The agent then plans, requests, and records findings.
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={onNew}>
              <Plus size={15} /> Create the first task
            </button>
          </div>
        </Empty>
      </Card>
    );
  }
  const active = api.activeTask ?? ws.tasks[0];
  return (
    <div className="task-grid">
      <Card>
        <CardHead
          title="Tasks"
          hint={`${ws.tasks.filter((t) => t.status === "done").length} done`}
          right={
            <button className="btn sm" onClick={onNew}>
              <Plus size={13} /> New
            </button>
          }
        />
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th className="nowrap">Status</th>
              <th className="nowrap">Turns</th>
              <th className="nowrap">Requests</th>
              <th className="nowrap">Findings</th>
              <th className="nowrap">Created</th>
            </tr>
          </thead>
          <tbody>
            {ws.tasks.map((t) => (
              <tr key={t.id} className={`clickable ${active?.id === t.id ? "selected" : ""}`} onClick={() => api.selectTask(t.id)}>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <StatusDot state={t.status} />
                    <div style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 550 }}>
                        {t.name}
                      </div>
                      <div className="tiny faint truncate">{describeScope(t.extraScope).join(", ")}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <StatusChip task={t} />
                </td>
                <td className="mono tiny">
                  {t.turnsUsed}/{t.turnBudget}
                </td>
                <td className="mono tiny">
                  {t.requestsUsed}/{t.requestBudget}
                </td>
                <td>
                  {t.findings.length > 0 ? <Chip tone="warn">{t.findings.length}</Chip> : <span className="faint tiny">—</span>}
                </td>
                <td className="tiny faint nowrap">{timeAgo(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {active ? <RunPanel api={api} task={active} /> : null}
    </div>
  );
}

function StatusChip({ task }: { task: Task }) {
  switch (task.status) {
    case "running":
      return (
        <Chip tone="ok">
          <span className="dot live" /> running
        </Chip>
      );
    case "paused":
      return <Chip tone="warn">paused</Chip>;
    case "failed":
      return <Chip tone="bad">failed</Chip>;
    case "stopped":
      return <Chip>stopped</Chip>;
    case "done":
      return <Chip tone="info">done</Chip>;
    default:
      return <Chip>idle</Chip>;
  }
}

function RunPanel({ api, task }: { api: WorkspaceApi; task: Task }) {
  const [tab, setTab] = React.useState<"trace" | "tools" | "findings" | "hypotheses" | "scope">("trace");
  const [message, setMessage] = React.useState("");
  const traceRef = React.useRef<HTMLDivElement>(null);
  const isActive = api.activeTask?.id === task.id && api.running;

  React.useEffect(() => {
    if (traceRef.current) traceRef.current.scrollTop = traceRef.current.scrollHeight;
  }, [task.transcript.length]);

  const requestPct = Math.min(100, Math.round((task.requestsUsed / Math.max(1, task.requestBudget)) * 100));
  const turnPct = Math.min(100, Math.round((task.turnsUsed / Math.max(1, task.turnBudget)) * 100));

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="run-head">
            <StatusChip task={task} />
            <strong style={{ fontSize: 15 }}>{task.name}</strong>
            <div className="spacer" />
            {isActive ? (
              <>
                <button className="btn sm" onClick={api.pauseTask}>
                  <Pause size={13} /> {api.paused ? "Resume" : "Pause"}
                </button>
                <button className="btn sm danger" onClick={api.stopTask}>
                  <CircleStop size={13} /> Stop
                </button>
              </>
            ) : (
              <button
                className="btn primary sm"
                onClick={() => void api.startTask(task.id)}
                disabled={api.running || task.status === "running"}
                title={task.status === "done" ? "Run again with the same goal and scope" : undefined}
              >
                <Play size={13} /> {task.status === "idle" ? "Start" : "Run again"}
              </button>
            )}
            <button
              className="btn ghost sm"
              onClick={() => {
                if (window.confirm(`Delete "${task.name}" and its ${task.findings.length} finding(s)?`)) api.deleteTask(task.id);
              }}
              aria-label="Delete task"
            >
              <Trash2 size={13} />
            </button>
          </div>

          <div className="tiny muted" style={{ whiteSpace: "pre-wrap" }}>
            {task.goal}
          </div>

          <div className="row wrap tiny">
            {describeScope(task.extraScope).map((s) => (
              <Chip key={s} tone="ok">
                {s}
              </Chip>
            ))}
          </div>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <div>
              <div className="row tiny faint" style={{ marginBottom: 4 }}>
                <span>Requests</span>
                <div className="spacer" />
                <span className="mono">
                  {task.requestsUsed}/{task.requestBudget}
                </span>
              </div>
              <div className="meter">
                <i style={{ width: `${requestPct}%` }} />
              </div>
            </div>
            <div>
              <div className="row tiny faint" style={{ marginBottom: 4 }}>
                <span>Model turns</span>
                <div className="spacer" />
                <span className="mono">
                  {task.turnsUsed}/{task.turnBudget}
                </span>
              </div>
              <div className="meter">
                <i style={{ width: `${turnPct}%` }} />
              </div>
            </div>
          </div>

          <div className="kpis">
            <div className="kpi">
              <div className="k">Findings</div>
              <div className="v">{task.findings.length}</div>
            </div>
            <div className="kpi">
              <div className="k">Tokens in/out</div>
              <div className="v" style={{ fontSize: 13 }}>
                {num(task.tokens.input)} / {num(task.tokens.output)}
              </div>
            </div>
            <div className="kpi">
              <div className="k">Model calls</div>
              <div className="v" style={{ fontSize: 15 }}>
                {task.tokens.calls}
              </div>
            </div>
            <div className="kpi">
              <div className="k">Last activity</div>
              <div className="v" style={{ fontSize: 13 }}>
                {task.tools.length > 0 ? timeAgo(task.tools[task.tools.length - 1]!.at) : "—"}
              </div>
            </div>
          </div>

          {task.summary && (
            <Banner tone="ok">
              <strong>Summary from the run:</strong> {task.summary}
            </Banner>
          )}
        </div>
      </Card>

      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs
            tabs={[
              { id: "trace", label: "Trace", count: task.transcript.length },
              { id: "tools", label: "Tool calls", count: task.tools.length },
              { id: "findings", label: "Findings", count: task.findings.length },
              { id: "hypotheses", label: "Hypotheses", count: task.hypotheses.length },
              { id: "scope", label: "Scope" },
            ]}
            active={tab}
            onChange={setTab}
          />
        </div>

        {tab === "trace" && (
          <div ref={traceRef} className="scroll" style={{ maxHeight: 440 }}>
            {task.transcript.length === 0 ? (
              <Empty icon={<Activity size={24} />} title="Nothing yet">
                Press Start and the first model turn appears here, followed by every tool call it makes.
              </Empty>
            ) : (
              <div className="trace">
                {task.transcript.map((tr) => (
                  <div key={tr.id} className={`trace-entry ${tr.role}`}>
                    <div className="trace-who">{tr.role === "tool" ? "tool" : tr.role}</div>
                    <div className="trace-text">{tr.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "tools" && (
          <div className="scroll" style={{ maxHeight: 440 }}>
            {task.tools.length === 0 ? (
              <Empty icon={<Receipt size={24} />} title="No tool calls yet" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="nowrap">Turn</th>
                    <th className="nowrap">Time</th>
                    <th>Action</th>
                    <th className="nowrap">Result</th>
                    <th className="nowrap">Took</th>
                  </tr>
                </thead>
                <tbody>
                  {[...task.tools].reverse().map((t) => (
                    <tr key={t.id}>
                      <td className="mono tiny">{t.turn}</td>
                      <td className="tiny faint nowrap">{clock(t.at)}</td>
                      <td>
                        <div className="mono tiny" style={{ color: "var(--text)" }}>
                          {t.summary}
                        </div>
                      </td>
                      <td>
                        <Chip tone={t.status === "ok" ? "ok" : t.status === "blocked" ? "warn" : "bad"}>{t.status}</Chip>
                      </td>
                      <td className="tiny faint nowrap">{t.durationMs != null ? duration(t.durationMs) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === "findings" && (
          <div className="card-pad grid" style={{ gap: 10 }}>
            {task.findings.length === 0 ? (
              <Empty icon={<TriangleAlert size={24} />} title="No findings recorded">
                The agent records a finding only when it can point at the response that proves it.
              </Empty>
            ) : (
              task.findings.map((f) => (
                <div className="finding" key={f.id}>
                  <div className="row wrap">
                    <Severity value={f.severity} />
                    <strong>{f.title}</strong>
                    <div className="spacer" />
                    <span className="tiny faint mono">{f.asset}</span>
                  </div>
                  {f.evidence && <pre>{f.evidence}</pre>}
                  {f.remediation && (
                    <div className="small muted">
                      <b>Remediation:</b> {f.remediation}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === "hypotheses" && (
          <div className="card-pad">
            {task.hypotheses.length === 0 ? (
              <Empty icon={<Activity size={24} />} title="No hypotheses yet" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Idea</th>
                    <th className="nowrap">Status</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {task.hypotheses.map((h) => (
                    <tr key={h.id}>
                      <td>{h.text}</td>
                      <td>
                        <Chip tone={h.status === "supported" ? "ok" : h.status === "rejected" ? "bad" : "warn"}>{h.status}</Chip>
                      </td>
                      <td className="small muted">{h.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === "scope" && (
          <div className="card-pad grid" style={{ gap: 10 }}>
            <Banner tone="warn">
              Scope is enforced before every request. Anything not listed here is blocked by the harness, even if the model asks for it.
            </Banner>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {describeScope(task.extraScope).map((s) => (
                <li key={s} className="mono">
                  {s}
                </li>
              ))}
            </ul>
            <div className="tiny faint">
              Created {new Date(task.createdAt).toLocaleString()} · started {task.startedAt ? new Date(task.startedAt).toLocaleString() : "—"} · ended{" "}
              {task.endedAt ? new Date(task.endedAt).toLocaleString() : "—"}
            </div>
          </div>
        )}

        <div className="chatbar">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={api.running ? "A run is active — pause or stop it to send a message." : "Tell ARTEX what to do next, e.g. “check /admin and /api/v1/users”"}
            disabled={api.running}
            onKeyDown={(e) => {
              if (e.key === "Enter" && message.trim() && !api.running) {
                void api.sendMessage(task.id, message);
                setMessage("");
              }
            }}
          />
          <button
            className="btn primary"
            disabled={api.running || !message.trim()}
            onClick={() => {
              void api.sendMessage(task.id, message);
              setMessage("");
            }}
          >
            <SendHorizontal size={15} />
          </button>
        </div>
      </Card>
    </div>
  );
}
