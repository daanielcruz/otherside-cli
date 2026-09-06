import type { ToolHandler } from "@/engine/tools/contract.ts";
import { Agent } from "./agent.ts";
import { AskUserQuestion } from "./askuserquestion.ts";
import { Bash } from "./bash.ts";
import { CronCreate, CronDelete, CronList } from "./cron.ts";
import { ReadDesign } from "./design/read-design.ts";
import { Edit } from "./edit/edit.ts";
import { NotebookEdit } from "./edit/notebook.ts";
import { GenerateImage } from "./image/generate-image.ts";
import { LSP } from "./lsp.ts";
import {
  ListMcpResourcesTool,
  ReadMcpResourceDirTool,
  ReadMcpResourceTool,
} from "./mcp/mcp_resources.ts";
import { ToolSearch } from "./mcp/toolsearch.ts";
import { MISSING_MCP_TOOLS_WAITER } from "./mcp/wait_for_mcp_servers.ts";
import { EnterPlanMode, ExitPlanMode } from "./plan.ts";
import { Read } from "./read/read.ts";
import { ReportFindings } from "./report-findings.ts";
import { ScheduleWakeup } from "./schedule-wakeup.ts";
import { SendMessage } from "./sendmessage.ts";
import { Skill } from "./skill.ts";
import { StructuredOutput } from "./structuredoutput.ts";
import { TaskCreate, TaskGet, TaskList, TaskUpdate } from "./task/task.ts";
import { TaskOutput, TaskStop } from "./task/task-control.ts";
import { WebFetch } from "./web/webfetch.ts";
import { WebSearch } from "./web/websearch.ts";
import { Workflow } from "./workflow.ts";
import { EnterWorktree } from "./worktree-enter.ts";
import { ExitWorktree } from "./worktree-exit.ts";
import { Write } from "./write.ts";

export const BUILTINS: ToolHandler[] = [
  Bash,
  Read,
  ReportFindings,
  Edit,
  Write,
  Agent,
  SendMessage,
  Skill,
  ToolSearch,
  WebFetch,
  WebSearch,
  Workflow,
  TaskCreate,
  TaskUpdate,
  TaskList,
  TaskStop,
  TaskGet,
  TaskOutput,
  CronCreate,
  CronList,
  CronDelete,
  NotebookEdit,
  EnterPlanMode,
  EnterWorktree,
  ExitPlanMode,
  ExitWorktree,
  AskUserQuestion,
  LSP,
  ListMcpResourcesTool,
  ReadMcpResourceDirTool,
  ReadMcpResourceTool,
  MISSING_MCP_TOOLS_WAITER,
  StructuredOutput,
  ScheduleWakeup,
  GenerateImage,
  ReadDesign,
];
