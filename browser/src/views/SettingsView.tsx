// Settings: provider summary, run policy, data export/import, reset.

import * as React from "react";
import { Download, KeyRound, Trash2, Upload } from "lucide-react";

import { maskKey } from "../lib/providers.ts";
import { describeScope } from "../lib/scope.ts";
import { Banner, Card, CardHead, Chip, Field } from "../components/ui.tsx";
import type { WorkspaceApi } from "../state/useWorkspace.ts";

export function SettingsView({ api, onSetup }: { api: WorkspaceApi; onSetup: () => void }) {
  const [importText, setImportText] = React.useState("");
  const [importMsg, setImportMsg] = React.useState<string | undefined>();
  const [confirmReset, setConfirmReset] = React.useState(false);

  const exportFile = () => {
    const blob = new Blob([api.exportWorkspace()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `artex-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const res = api.importWorkspace(text);
    setImportMsg(res.ok ? "Workspace imported." : res.error);
  };

  return (
    <div className="grid" style={{ maxWidth: 900, gap: 14 }}>
      <Card>
        <CardHead title="Model provider" hint={api.llm ? api.llm.provider : "not configured"} right={<button className="btn sm" onClick={onSetup}><KeyRound size={13} /> Change</button>} />
        <div className="card-pad grid" style={{ gap: 10 }}>
          {api.llm ? (
            <dl className="kv">
              <dt>Endpoint</dt>
              <dd className="mono">{api.llm.baseUrl || "(not set)"}</dd>
              <dt>Model</dt>
              <dd className="mono">{api.llm.model}</dd>
              <dt>Key</dt>
              <dd className="mono">
                {api.llm.apiKey ? (
                  <span className="row" style={{ gap: 8 }}>
                    {maskKey(api.llm.apiKey)} <Chip tone={api.remembered ? "warn" : "ok"}>{api.remembered ? "remembered in this browser" : "this tab only"}</Chip>
                  </span>
                ) : (
                  <span className="faint">none (keyless provider?)</span>
                )}
              </dd>
              <dt>Limits</dt>
              <dd>
                max {api.llm.maxTokens} output tokens · temperature {api.llm.temperature}
              </dd>
            </dl>
          ) : (
            <Banner tone="warn">No provider configured. Setup takes about a minute.</Banner>
          )}
          {api.llm?.apiKey && (
            <div className="row">
              <button className="btn sm danger" onClick={api.forgetKey}>
                <Trash2 size={13} /> Forget the key
              </button>
              <span className="tiny faint">Removes it from this browser. You will paste it again next time.</span>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHead title="Run policy" hint="applies to the next start" />
        <div className="card-pad grid" style={{ gap: 14 }}>
          <Field label="Delay between model turns" help="A small pause keeps a misbehaving loop from burning your quota. 0–5000 ms.">
            <input
              type="number"
              min={0}
              max={5000}
              step={100}
              value={api.settings.turnDelayMs}
              onChange={(e) => api.updateSettings({ turnDelayMs: Number(e.target.value) })}
            />
          </Field>
          <label className="checkline">
            <input type="checkbox" checked={api.settings.blockPrivateRanges} onChange={(e) => api.updateSettings({ blockPrivateRanges: e.target.checked })} />
            <span>
              <b>Block private and loopback ranges.</b> Refuses literal 10/8, 172.16/12, 192.168/16, 127/8 and similar targets even
              when they are in scope. Turn off only when you are deliberately testing an internal lab.
            </span>
          </label>
          <label className="checkline">
            <input type="checkbox" checked={api.settings.approveNewHosts} onChange={(e) => api.updateSettings({ approveNewHosts: e.target.checked })} />
            <span>
              <b>Ask before the first request to each host.</b> A modal shows the exact URL and waits for you. Slower, but nothing
              leaves the tab unseen.
            </span>
          </label>
        </div>
      </Card>

      <Card>
        <CardHead title="Data" hint="everything lives in this browser" />
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="row wrap">
            <button className="btn" onClick={exportFile}>
              <Download size={14} /> Export workspace
            </button>
            <label className="btn" style={{ cursor: "pointer" }}>
              <Upload size={14} /> Import workspace
              <input
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="tiny faint">Exports omit the API key on purpose.</span>
          </div>
          {importMsg && <Banner tone={importMsg.includes("imported") ? "ok" : "bad"}>{importMsg}</Banner>}

          <details>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Paste an exported workspace instead
            </summary>
            <div className="grid" style={{ gap: 8, marginTop: 8 }}>
              <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={5} placeholder='{"version":1,…}' spellCheck={false} />
              <button
                className="btn sm"
                onClick={() => {
                  const res = api.importWorkspace(importText);
                  setImportMsg(res.ok ? "Workspace imported." : res.error);
                }}
                disabled={!importText.trim()}
              >
                Import
              </button>
            </div>
          </details>

          <hr style={{ border: 0, borderTop: "1px solid var(--line-soft)", margin: "6px 0" }} />

          <div className="row wrap">
            {!confirmReset ? (
              <button className="btn danger" onClick={() => setConfirmReset(true)}>
                <Trash2 size={14} /> Clear everything
              </button>
            ) : (
              <>
                <span className="small">Delete all tasks, findings and the stored key?</span>
                <button
                  className="btn danger"
                  onClick={() => {
                    api.resetAll();
                    setConfirmReset(false);
                  }}
                >
                  Yes, delete
                </button>
                <button className="btn" onClick={() => setConfirmReset(false)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Tasks at a glance" hint={`${api.ws.tasks.length}`} />
        <div className="card-pad grid" style={{ gap: 6 }}>
          {api.ws.tasks.length === 0 ? (
            <span className="small faint">No tasks.</span>
          ) : (
            api.ws.tasks.map((t) => (
              <div key={t.id} className="row small" style={{ gap: 8 }}>
                <span className="truncate" style={{ minWidth: 0, flex: 1 }}>
                  {t.name}
                </span>
                <span className="tiny faint mono truncate" style={{ maxWidth: 260 }}>
                  {describeScope(t.extraScope).join(", ")}
                </span>
                <Chip>{t.status}</Chip>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
