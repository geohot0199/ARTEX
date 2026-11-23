// All findings across tasks, grouped by severity.

import * as React from "react";
import { Receipt } from "lucide-react";

import { SEVERITIES, type Finding, type Severity as Sev } from "../lib/types.ts";
import { timeAgo } from "../lib/format.ts";
import { Card, CardHead, Chip, Empty, Severity } from "../components/ui.tsx";
import type { WorkspaceApi } from "../state/useWorkspace.ts";

interface Row extends Finding {
  taskId: string;
  taskName: string;
}

export function FindingsView({ api }: { api: WorkspaceApi }) {
  const [filter, setFilter] = React.useState<Sev | "all">("all");
  const rows: Row[] = React.useMemo(
    () =>
      api.ws.tasks
        .flatMap((t) => t.findings.map((f) => ({ ...f, taskId: t.id, taskName: t.name })))
        .sort((a, b) => b.createdAt - a.createdAt),
    [api.ws.tasks],
  );
  const visible = filter === "all" ? rows : rows.filter((r) => r.severity === filter);
  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.severity] = (c[r.severity] ?? 0) + 1;
    return c;
  }, [rows]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), findings: rows }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `artex-findings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportMarkdown = () => {
    const md = [
      `# ARTEX findings`,
      ``,
      `Exported ${new Date().toISOString()}`,
      ``,
      ...rows.map(
        (r) =>
          `## [${r.severity.toUpperCase()}] ${r.title}\n\n- Asset: ${r.asset}\n- Task: ${r.taskName}\n- Recorded: ${new Date(r.createdAt).toISOString()}\n\n**Evidence**\n\n\`\`\`\n${r.evidence}\n\`\`\`\n\n**Remediation:** ${r.remediation || "n/a"}\n`,
      ),
    ].join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `artex-findings-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card>
      <CardHead
        title="Findings"
        hint={`${rows.length} total`}
        right={
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={exportMarkdown} disabled={rows.length === 0}>
              Export .md
            </button>
            <button className="btn sm" onClick={exportJson} disabled={rows.length === 0}>
              Export .json
            </button>
          </div>
        }
      />
      <div className="card-pad row wrap" style={{ gap: 6, paddingBottom: 10 }}>
        <button className={`chip ${filter === "all" ? "brand" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilter("all")}>
          all · {rows.length}
        </button>
        {SEVERITIES.map((s) => (
          <button key={s} className={`chip ${filter === s ? "brand" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilter(s)}>
            {s} · {counts[s] ?? 0}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <Empty icon={<Receipt size={26} />} title={rows.length === 0 ? "No findings yet" : "Nothing at this severity"}>
          {rows.length === 0 ? "Findings appear here the moment the agent proves one." : undefined}
        </Empty>
      ) : (
        <div className="card-pad grid" style={{ gap: 10 }}>
          {visible.map((f) => (
            <div className="finding" key={f.id}>
              <div className="row wrap">
                <Severity value={f.severity} />
                <strong>{f.title}</strong>
                <div className="spacer" />
                <Chip>{f.taskName}</Chip>
                <span className="tiny faint">{timeAgo(f.createdAt)}</span>
              </div>
              <div className="tiny mono faint">{f.asset}</div>
              {f.evidence && <pre>{f.evidence}</pre>}
              {f.remediation && (
                <div className="small muted">
                  <b>Remediation:</b> {f.remediation}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
