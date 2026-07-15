import { hasEnabledPluginLspServers } from "@/engine/plugins/lsp.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import CronDeleteSchema from "@/harness/tools/CronDelete/tool.json" with { type: "json" };
import CronListSchema from "@/harness/tools/CronList/tool.json" with { type: "json" };
import EnterPlanModeSchema from "@/harness/tools/EnterPlanMode/tool.json" with { type: "json" };
import EnterWorktreeSchema from "@/harness/tools/EnterWorktree/tool.json" with { type: "json" };
import ExitPlanModeSchema from "@/harness/tools/ExitPlanMode/tool.json" with { type: "json" };
import ExitWorktreeSchema from "@/harness/tools/ExitWorktree/tool.json" with { type: "json" };
import GenerateImageSchema from "@/harness/tools/GenerateImage/tool.json" with { type: "json" };
import ListMcpResourcesSchema from "@/harness/tools/ListMcpResources/tool.json" with {
  type: "json",
};
import LSPSchema from "@/harness/tools/LSP/tool.json" with { type: "json" };
import NotebookEditSchema from "@/harness/tools/NotebookEdit/tool.json" with { type: "json" };
import ReadDesignSchema from "@/harness/tools/ReadDesign/tool.json" with { type: "json" };
import ReadMcpResourceSchema from "@/harness/tools/ReadMcpResource/tool.json" with { type: "json" };
import ReadMcpResourceDirSchema from "@/harness/tools/ReadMcpResourceDirTool/tool.json" with {
  type: "json",
};
import ScheduleWakeupSchema from "@/harness/tools/ScheduleWakeup/tool.json" with { type: "json" };
import SendMessageSchema from "@/harness/tools/SendMessage/tool.json" with { type: "json" };
import StructuredOutputSchema from "@/harness/tools/StructuredOutput/tool.json" with {
  type: "json",
};
import TaskCreateSchema from "@/harness/tools/TaskCreate/tool.json" with { type: "json" };
import TaskGetSchema from "@/harness/tools/TaskGet/tool.json" with { type: "json" };
import TaskListSchema from "@/harness/tools/TaskList/tool.json" with { type: "json" };
import TaskOutputSchema from "@/harness/tools/TaskOutput/tool.json" with { type: "json" };
import TaskStopSchema from "@/harness/tools/TaskStop/tool.json" with { type: "json" };
import TaskUpdateSchema from "@/harness/tools/TaskUpdate/tool.json" with { type: "json" };
import ToolSearchSchema from "@/harness/tools/ToolSearch/tool.json" with { type: "json" };
import WaitForMcpServersSchema from "@/harness/tools/WaitForMcpServers/tool.json" with {
  type: "json",
};
import WorkflowSchema from "@/harness/tools/Workflow/tool.json" with { type: "json" };
import { hasConnectedResourcesCapableMcpServer, hasPendingMcpServers } from "@/kernel/mcp/index.ts";
import { Edit as EditTool } from "./builtins/edit/edit.ts";
import { Read as ReadTool } from "./builtins/read/read.ts";
import { ReportFindings } from "./builtins/report-findings.ts";
import { Skill as SkillTool } from "./builtins/skill.ts";
import { AgentSchema } from "./dynamic/Agent.ts";
import { AskUserQuestionSchema } from "./dynamic/AskUserQuestion.ts";
import { BashSchema } from "./dynamic/Bash.ts";
import { CronCreateSchema } from "./dynamic/CronCreate.ts";
import { WebFetchSchema } from "./dynamic/WebFetch.ts";
import { WebSearchSchema } from "./dynamic/WebSearch.ts";
import { WriteSchema } from "./dynamic/Write.ts";

export {
  extractBaseCommand,
  splitCommandParts,
} from "@/engine/tools/_infra/command-analysis/commands.ts";
export {
  detectDestructiveCommand,
  getDestructiveCommandWarning,
} from "@/engine/tools/_infra/command-analysis/destructive.ts";
export { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
export { parseSedEditCommand } from "@/engine/tools/_infra/command-analysis/sed-edit.ts";

type ToolCatalogKind = "base" | "deferred";

interface ToolCatalogEntry {
  schema: ToolSchema;
  kind: ToolCatalogKind;
  isAvailable?: () => boolean;
}

// Single ordered source of truth for the bundled tool surface. Order is
// wire-significant (tools[] order keys the prompt cache) and pinned by
// catalog-golden.test.ts. `base` tools are always declared; `deferred` tools
// load on demand via ToolSearch. The standard catalog name/schema lists below
// derive from this; request-injected handler schemas may additionally live in allSchemas.
const TOOL_CATALOG = [
  { schema: AgentSchema, kind: "base" },
  { schema: AskUserQuestionSchema, kind: "base" },
  { schema: BashSchema, kind: "base" },
  { schema: EditTool.schema, kind: "base" },
  { schema: ReadTool.schema, kind: "base" },
  { schema: ReportFindings.schema, kind: "base" },
  { schema: SkillTool.schema, kind: "base" },
  { schema: ToolSearchSchema, kind: "base" },
  { schema: WorkflowSchema, kind: "base" },
  { schema: WriteSchema, kind: "base" },

  { schema: CronCreateSchema, kind: "deferred" },
  { schema: CronDeleteSchema, kind: "deferred" },
  { schema: CronListSchema, kind: "deferred" },
  { schema: EnterPlanModeSchema, kind: "deferred" },
  { schema: EnterWorktreeSchema, kind: "deferred" },
  { schema: ExitPlanModeSchema, kind: "deferred" },
  { schema: ExitWorktreeSchema, kind: "deferred" },
  { schema: GenerateImageSchema, kind: "deferred" },
  { schema: LSPSchema, kind: "deferred", isAvailable: hasEnabledPluginLspServers },
  {
    schema: ListMcpResourcesSchema,
    kind: "deferred",
    isAvailable: hasConnectedResourcesCapableMcpServer,
  },
  { schema: NotebookEditSchema, kind: "deferred" },
  {
    schema: ReadMcpResourceDirSchema,
    kind: "deferred",
    isAvailable: hasConnectedResourcesCapableMcpServer,
  },
  {
    schema: ReadMcpResourceSchema,
    kind: "deferred",
    isAvailable: hasConnectedResourcesCapableMcpServer,
  },
  { schema: ScheduleWakeupSchema, kind: "deferred" },
  { schema: SendMessageSchema, kind: "deferred" },
  { schema: TaskCreateSchema, kind: "deferred" },
  { schema: TaskGetSchema, kind: "deferred" },
  { schema: TaskListSchema, kind: "deferred" },
  { schema: TaskOutputSchema, kind: "deferred" },
  { schema: TaskStopSchema, kind: "deferred" },
  { schema: TaskUpdateSchema, kind: "deferred" },
  { schema: WebFetchSchema, kind: "deferred" },
  { schema: WebSearchSchema, kind: "deferred" },
  {
    schema: WaitForMcpServersSchema,
    kind: "deferred",
    isAvailable: hasPendingMcpServers,
  },
  { schema: ReadDesignSchema, kind: "deferred" },
] satisfies ToolCatalogEntry[];

function schemasForKind(
  kind: ToolCatalogKind,
  options?: { includeUnavailable?: boolean },
): ToolSchema[] {
  const includeUnavailable = options?.includeUnavailable ?? false;
  return TOOL_CATALOG.filter(
    (entry) =>
      entry.kind === kind &&
      (includeUnavailable || entry.isAvailable === undefined || entry.isAvailable()),
  ).map((entry) => entry.schema);
}

export const baseSchemas = schemasForKind("base");
export const BASE_TOOL_NAMES: readonly string[] = baseSchemas.map((schema) => schema.name);

export function deferredSchemas(): ToolSchema[] {
  return schemasForKind("deferred");
}

export function deferredToolNames(): string[] {
  return deferredSchemas().map((schema) => schema.name);
}

export const allSchemas = [
  ...schemasForKind("base", { includeUnavailable: true }),
  ...schemasForKind("deferred", { includeUnavailable: true }),
  // Handler-only: each active outputSchema injects its request-specific declaration.
  StructuredOutputSchema,
] satisfies ToolSchema[];

const byName = new Map(allSchemas.map((schema) => [schema.name, schema]));

export function schemaFor(name: string): ToolSchema | undefined {
  return byName.get(name);
}

export function requireSchema(name: string): ToolSchema {
  const schema = schemaFor(name);
  if (!schema) throw new Error(`missing bundled tool schema: ${name}`);
  return schema;
}
