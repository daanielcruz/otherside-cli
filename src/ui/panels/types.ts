import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import type {
  WorkflowProgressItem,
  WorkflowTaskStatus,
} from "@/engine/background/workflows/runtime/store/types.ts";

export interface WorkflowDetailItem {
  name: string;
  description: string;
  status: WorkflowTaskStatus;
  startTime: number;
  durationMs: number;
  agentCount: number;
  script: string;
  phases: WorkflowPhaseSpec[];
  workflowProgress: WorkflowProgressItem[];
}

export type DetailLevel = "phases" | "agents" | "agent";
