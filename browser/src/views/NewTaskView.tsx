// Create a task: a goal in plain language plus the exact scope.

import * as React from "react";
import { Play, ShieldCheck, TriangleAlert } from "lucide-react";

import { parseScopeItem, describeScope } from "../lib/scope.ts";
import { Banner, Card, CardHead, Chip, Field } from "../components/ui.tsx";
import type { WorkspaceApi } from "../state/useWorkspace.ts";

const EXAMPLES = [
  {
    label: "Web app baseline",
    goal: "Check my own web application for the OWASP Top 10 categories that can be proven with a single request: missing security headers, reflected XSS indicators, error pages leaking stack traces, directory listing, and cookies without HttpOnly/Secure.",
    targets: "example.com",
  },
  {
    label: "Headers & TLS hygiene",
    goal: "Review HTTP response security headers, cookie flags and redirect behaviour across the main hosts, and record one finding per missing control with the response as evidence.",
    targets: "example.com",
  },
  {
    label: "Staging smoke check",
    goal: "Probe the staging environment for accidentally public admin endpoints, debug routes, .git exposure and default error pages.",
    targets: "staging.example.com",
  },
];

export function NewTaskView({ api, onCreated }: { api: WorkspaceApi; onCreated: (id: string, start: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [targets, setTargets] = React.useState("");
  const [turnBudget, setTurnBudget] = React.useState(16);
  const [requestBudget, setRequestBudget] = React.useState(30);
  const [error, setError] = React.useState<string | undefined>();

  const parsed = React.useMemo(() => (targets.trim() ? parseScopeItem(targets) : undefined), [targets]);
  const scopeLines = parsed?.ok ? describeScope(parsed.rules) : [];

  const create = (start: boolean) => {
    setError(undefined);
    const res = api.addTask({ name, goal, targets, turnBudget, requestBudget });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.taskId) {
      setError("The task could not be created.");
      return;
    }
    onCreated(res.taskId, start);
  };

  return (
    <div className="grid" style={{ maxWidth: 900, gap: 14 }}>
      <Card>
        <CardHead title="What should it go after?" hint="one task = one goal" />
        <div className="card-pad grid" style={{ gap: 14 }}>
          <Field label="Task name" help="Optional. Defaults to the first target.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme storefront baseline" />
          </Field>

          <Field
            label="Goal"
            help="Be concrete: what to look for and what counts as proof. The planner turns this into steps."
          >
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={5}
              placeholder="Check example.com for missing security headers, exposed debug pages and cookie flags; record a finding for each confirmed issue with the response as evidence."
            />
          </Field>

          <Field
            label="Targets in scope"
            help="Comma or space separated. example.com covers its subdomains; *.example.com covers only subdomains; CIDR ranges and single IPs work too."
          >
            <input value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="example.com, api.example.com, 10.0.0.0/24" spellCheck={false} />
          </Field>

          {parsed && !parsed.ok && <Banner tone="bad">{parsed.error}</Banner>}
          {parsed?.ok && (
            <div className="row wrap small">
              <ShieldCheck size={14} style={{ color: "var(--ok)" }} />
              <span className="muted">Allowed:</span>
              {scopeLines.map((s) => (
                <Chip key={s} tone="ok">
                  {s}
                </Chip>
              ))}
            </div>
          )}

          <div className="grid grid-2">
            <Field label="Turn budget" help="Model calls before it must wrap up. 12–20 is a good first run.">
              <input type="number" min={3} max={200} value={turnBudget} onChange={(e) => setTurnBudget(Number(e.target.value))} />
            </Field>
            <Field label="Request budget" help="Hard cap on HTTP requests to the target.">
              <input type="number" min={1} max={500} value={requestBudget} onChange={(e) => setRequestBudget(Number(e.target.value))} />
            </Field>
          </div>

          {error && <Banner tone="bad">{error}</Banner>}

          <div className="row">
            <button className="btn primary" onClick={() => create(true)} disabled={!goal.trim() || !targets.trim() || !parsed?.ok}>
              <Play size={15} /> Create and start
            </button>
            <button className="btn" onClick={() => create(false)} disabled={!goal.trim() || !targets.trim() || !parsed?.ok}>
              Create, don't start
            </button>
            <div className="spacer" />
            <span className="tiny faint">The first request is previewed in the run console.</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Examples" hint="click to fill in" />
        <div className="card-pad grid" style={{ gap: 10 }}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              className="provider"
              onClick={() => {
                setGoal(ex.goal);
                setTargets(ex.targets);
                setName("");
              }}
            >
              <span className="p-name">{ex.label}</span>
              <span className="p-note">{ex.goal.slice(0, 120)}…</span>
            </button>
          ))}
        </div>
      </Card>

      <Banner tone="warn">
        <TriangleAlert size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
        Every request leaves from your own browser, so it carries your IP address and session. Only point this at systems you
        are authorised to test.
      </Banner>
    </div>
  );
}
