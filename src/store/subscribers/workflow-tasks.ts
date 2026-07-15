import {
  listWorkflowTasks,
  subscribeWorkflowTasks,
  type WorkflowTaskSnapshot,
} from "@/kernel/channels/workflow-tasks.ts";
import { dispatch } from "@/store/app-store/index.ts";

export function startWorkflowTasksSubscriber(): () => void {
  dispatch({ type: "engine/setSlice", key: "workflowTasks", value: listWorkflowTasks() });
  return subscribeWorkflowTasks(() => {
    dispatch({ type: "engine/setSlice", key: "workflowTasks", value: listWorkflowTasks() });
  });
}

export function readWorkflowTasksSlice(
  engine: Readonly<Record<string, unknown>>,
): WorkflowTaskSnapshot[] | undefined {
  const value = engine.workflowTasks;
  if (value === undefined) return undefined;
  return value as WorkflowTaskSnapshot[];
}
