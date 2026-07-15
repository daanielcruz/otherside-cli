export const WORKFLOW_SCRIPT_MAX_BYTES = 524288;

export interface WorkflowPhaseDescriptor {
  index: number;
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseDescriptor[];
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  body: string;
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}
