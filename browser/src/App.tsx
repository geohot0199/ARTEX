import * as React from "react";
import { KeyRound, LayoutGrid, Plus, Receipt, ShieldAlert, SlidersHorizontal, Bot } from "lucide-react";

import { useWorkspace } from "./state/useWorkspace.ts";
import { SetupView } from "./views/SetupView.tsx";
import { TasksView } from "./views/TasksView.tsx";
import { NewTaskView } from "./views/NewTaskView.tsx";
import { FindingsView } from "./views/FindingsView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { ApprovalDialog } from "./views/ApprovalDialog.tsx";
import { Banner, Chip } from "./components/ui.tsx";
import { maskKey } from "./lib/providers.ts";

export type Route = "tasks" | "new" | "findings" | "settings" | "setup";

export function App() {
  const api = useWorkspace();
  const [route, setRoute] = React.useState<Route>(() => (api.llm && api.ws.acceptedTerms ? "tasks" : "setup"));
  const [editingTask, setEditingTask] = React.useState<string | undefined>(undefined);

  // New installs land on Setup; once saved, land on the task list.
  const configured = Boolean(api.llm && api.ws.acceptedTerms);
  React.useEffect(() => {
    if (!configured && route !== "setup") setRoute("setup");
  }, [configured, route]);

  const findingsCount = api.ws.tasks.reduce((n, t) => n + t.findings.length, 0);
  const activeRuns = api.ws.tasks.filter((t) => t.status === "running").length;

  const nav = (r: Route) => {
    setEditingTask(undefined);
    setRoute(r);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="logo.svg" alt="" />
          <div>
            <div className="brand-name">ARTEX</div>
            <div className="brand-tag">browser edition</div>
          </div>
        </div>

        <button className={`nav-item ${route === "tasks" ? "active" : ""}`} onClick={() => nav("tasks")}>
          <LayoutGrid size={15} /> Tasks
          {api.ws.tasks.length > 0 && <span className="count">{api.ws.tasks.length}</span>}
        </button>
        <button className={`nav-item ${route === "new" ? "active" : ""}`} onClick={() => nav("new")}>
          <Plus size={15} /> New task
        </button>
        <button className={`nav-item ${route === "findings" ? "active" : ""}`} onClick={() => nav("findings")}>
          <Receipt size={15} /> Findings
          {findingsCount > 0 && <span className="count">{findingsCount}</span>}
        </button>
        <button className={`nav-item ${route === "settings" ? "active" : ""}`} onClick={() => nav("settings")}>
          <SlidersHorizontal size={15} /> Settings
        </button>

        <div className="nav-spacer" />

        <div className="side-foot">
          {api.llm ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <Chip tone={api.llm.apiKey || api.llm.provider === "ollama" ? "ok" : "warn"}>
                <Bot size={11} /> {api.llm.provider}
              </Chip>
              {api.llm.apiKey ? <span className="mono tiny">{maskKey(api.llm.apiKey)}</span> : <span className="tiny">no key</span>}
            </div>
          ) : (
            <Chip tone="warn">
              <KeyRound size={11} /> no provider
            </Chip>
          )}
          <button className="btn ghost sm" onClick={() => nav("setup")} style={{ justifyContent: "flex-start", paddingLeft: 4 }}>
            Change provider
          </button>
          <div className="row tiny" style={{ gap: 6 }}>
            <ShieldAlert size={11} />
            <span>Only test what you own.</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>
              {route === "tasks" && "Tasks"}
              {route === "new" && "New task"}
              {route === "findings" && "Findings"}
              {route === "settings" && "Settings"}
              {route === "setup" && "Setup"}
            </h1>
            <div className="sub">
              {route === "tasks" && "Autonomous runs in this browser — no server, no database."}
              {route === "new" && "Give it a goal and the hosts it may touch."}
              {route === "findings" && "Everything the agent proved, with the evidence that proves it."}
              {route === "settings" && "Provider, key handling, run policy and data."}
              {route === "setup" && "Connect a model. Takes about a minute."}
            </div>
          </div>
          <div className="topbar-right">
            {activeRuns > 0 && (
              <Chip tone="brand">
                <span className="dot live" /> {activeRuns} running
              </Chip>
            )}
            {route !== "new" && (
              <button className="btn primary" onClick={() => nav("new")}>
                <Plus size={15} /> New task
              </button>
            )}
          </div>
        </header>

        <div className="content">
          {api.notice && (
            <div style={{ marginBottom: 14 }}>
              <Banner onClose={api.dismissNotice}>{api.notice}</Banner>
            </div>
          )}

          {route === "setup" && <SetupView api={api} onDone={() => setRoute("tasks")} />}
          {route === "tasks" && (
            <TasksView
              api={api}
              onNew={() => nav("new")}
              onEditTask={(id) => {
                setEditingTask(id);
                setRoute("tasks");
              }}
              editingTaskId={editingTask}
              clearEditing={() => setEditingTask(undefined)}
            />
          )}
          {route === "new" && (
            <NewTaskView
              api={api}
              onCreated={(id, start) => {
                api.selectTask(id);
                setRoute("tasks");
                if (start) void api.startTask(id);
              }}
            />
          )}
          {route === "findings" && <FindingsView api={api} />}
          {route === "settings" && <SettingsView api={api} onSetup={() => nav("setup")} />}
        </div>
      </main>

      {api.pendingApproval && <ApprovalDialog approval={api.pendingApproval} onResolve={api.resolveApproval} />}
    </div>
  );
}
