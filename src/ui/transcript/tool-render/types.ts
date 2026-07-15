import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";

export type ToolStatus = "queued" | "running" | "ok" | "error";

// Tool-call headers only — inner tool results never render in the parent transcript.
export interface NestedEntry {
  toolName: string;
  args: unknown;
  running: boolean;
}

export type ToolPayload =
  | { kind: "preview"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "hint"; text: string }
  | { kind: "interrupt" }
  | { kind: "workflow"; task: LocalWorkflowTaskState }
  | { kind: "diff"; fragment: string; filePath?: string }
  | {
      kind: "findings";
      findings: Array<{
        file: string;
        line: number;
        summary: string;
        failure_scenario: string;
        verdict?: "CONFIRMED" | "PLAUSIBLE";
        outcome?: "fixed" | "skipped" | "no_change_needed";
      }>;
    }
  | {
      kind: "bash";
      stdout: string;
      stderr: string;
      exitCode: number;
      noOutputExpected?: boolean;
      returnCodeInterpretation?: string;
    };
