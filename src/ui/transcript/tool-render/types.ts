import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import type { NestedToolEntry } from "@/engine/session/record/types.ts";
import type { McpCallIdentity } from "@/kernel/mcp/index.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { AgentChipDescriptor } from "@/ui/transcript/agent-chip-data.ts";

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
  | { kind: "workflow"; task: WorkflowTaskLifecycle }
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

export interface ToolNestedEntry extends NestedToolEntry {
  argumentLabel?: string;
}

export interface ToolEntryData {
  name: string;
  args: unknown;
  /** Stored with the call; names it once its MCP server is gone. */
  mcpIdentity?: McpCallIdentity;
  status: ToolStatus;
  payload: ToolPayload | null;
  elapsedMs?: number;
  agentRoute?: ProviderModelRoute;
  producerRoute?: ProviderModelRoute;
  completionChip?: AgentChipDescriptor | null;
  nested?: readonly ToolNestedEntry[];
  isBackgrounded?: boolean;
  /** True while a background task still feeds this row, so it reads as live. */
  taskRunning?: boolean;
}
