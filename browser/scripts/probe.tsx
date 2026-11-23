// Smoke-test helper: render one screen against a real useWorkspace() state.
//
// Lives in scripts/ (not src/test/) because it is only used by scripts/smoke.ts.

import * as React from "react";

import { useWorkspace } from "../src/state/useWorkspace.ts";
import { SetupView } from "../src/views/SetupView.tsx";
import { NewTaskView } from "../src/views/NewTaskView.tsx";
import { TasksView } from "../src/views/TasksView.tsx";
import { FindingsView } from "../src/views/FindingsView.tsx";
import { SettingsView } from "../src/views/SettingsView.tsx";
import { ApprovalDialog } from "../src/views/ApprovalDialog.tsx";
import type { PendingApproval } from "../src/state/useWorkspace.ts";

const noop = () => {};

export function WorkspaceApiProbe({ screen }: { screen: "setup" | "new" | "tasks" | "findings" | "settings" }) {
  const api = useWorkspace();
  switch (screen) {
    case "setup":
      return React.createElement(SetupView, { api, onDone: noop });
    case "new":
      return React.createElement(NewTaskView, { api, onCreated: noop });
    case "tasks":
      return React.createElement(TasksView, {
        api,
        onNew: noop,
        onEditTask: noop,
        clearEditing: noop,
      });
    case "findings":
      return React.createElement(FindingsView, { api });
    case "settings":
      return React.createElement(SettingsView, { api, onSetup: noop });
  }
}

export function ApprovalProbe() {
  const approval: PendingApproval = {
    host: "api.example.com",
    url: "https://api.example.com/v1/health",
    resolve: noop,
  };
  return React.createElement(ApprovalDialog, { approval, onResolve: noop });
}
