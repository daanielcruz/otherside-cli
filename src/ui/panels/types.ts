import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import type {
  WorkflowProgressEntry,
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
  phases: WorkflowPhaseDescriptor[];
  workflowProgress: WorkflowProgressEntry[];
}

export type DetailLevel = "phases" | "agents" | "agent";
