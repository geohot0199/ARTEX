// "Approve the first request to this host" prompt. Runs only when the operator turns
// on approveNewHosts in Settings.

import { ShieldQuestion } from "lucide-react";
import { Modal } from "../components/ui.tsx";
import type { PendingApproval } from "../state/useWorkspace.ts";

export function ApprovalDialog({ approval, onResolve }: { approval: PendingApproval; onResolve: (allow: boolean) => void }) {
  return (
    <Modal title="Approve first request" onClose={() => onResolve(false)}>
      <div className="row" style={{ gap: 10 }}>
        <ShieldQuestion size={20} style={{ color: "var(--warn)" }} />
        <div>
          <div style={{ fontWeight: 600 }}>{approval.host}</div>
          <div className="tiny faint">The agent has not contacted this host yet in this task.</div>
        </div>
      </div>
      <pre className="mono small" style={{ margin: 0, padding: 10, background: "#0d0a16", border: "1px solid var(--line-soft)", borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {approval.url}
      </pre>
      <div className="row">
        <button className="btn" onClick={() => onResolve(false)}>
          Deny
        </button>
        <div className="spacer" />
        <button className="btn primary" onClick={() => onResolve(true)}>
          Allow {approval.host}
        </button>
      </div>
    </Modal>
  );
}
