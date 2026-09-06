export const HOOK_EVENT_VALUES = [
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "postToolBatch",
  "userPromptSubmit",
  "userPromptExpansion",
  "stop",
  "stopFailure",
  "subagentStop",
  "preCompact",
  "postCompact",
  "taskCreated",
  "taskCompleted",
  "sessionStart",
  "sessionEnd",
  "subagentStart",
  "permissionRequest",
  "permissionDenied",
  "teammateIdle",
  "elicitation",
  "elicitationResult",
  "configChange",
  "instructionsLoaded",
  "cwdChanged",
  "directoryAdded",
  "messageDisplay",
  "Setup",
  "Notification",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
] as const;

export type HookEvent = (typeof HOOK_EVENT_VALUES)[number];

export const SESSION_END_REASON_VALUES = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "other",
  "bypass_permissions_disabled",
] as const;

export type SessionEndReason = (typeof SESSION_END_REASON_VALUES)[number];

// sessionId/cwd ride along for the stdin JSON payload only — the env surface is
// unchanged. Present whenever the firing call site knows them.
export interface PreToolUseCtx {
  toolName: string;
  toolInput: string;
  sessionId?: string;
  cwd?: string;
}

export interface PostToolUseCtx {
  toolName: string;
  toolInput: string;
  toolExit: number;
  toolResponse?: unknown;
  toolUseId?: string;
  durationMs?: number;
  sessionId?: string;
  cwd?: string;
}

export interface PostToolUseFailureCtx {
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  error: string;
  isInterrupt?: boolean;
  durationMs?: number;
  sessionId?: string;
  cwd?: string;
}

export interface PostToolBatchCall {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  tool_response?: unknown;
}

export interface PostToolBatchCtx {
  toolCalls: PostToolBatchCall[];
  sessionId: string;
  cwd: string;
}

export interface UserPromptSubmitCtx {
  promptText: string;
}

export interface UserPromptExpansionCtx {
  expansionType: "slash_command" | "mcp_prompt";
  commandName: string;
  commandArgs: string;
  commandSource?: string;
  prompt: string;
  sessionId: string;
  cwd: string;
}

export interface StopCtx {
  sessionId: string;
  /** True when the stopping turn was started by a stop-hook rewake
   * notification — lets a hook script break the rewake loop. */
  stopHookActive?: boolean;
}

export type StopFailureError =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

export interface StopFailureCtx {
  sessionId: string;
  cwd: string;
  error: StopFailureError;
  errorDetails?: string;
  lastAssistantMessage?: string;
}

export interface SubagentStopCtx {
  sessionId: string;
  subagentId: string;
}

export interface PreCompactCtx {
  sessionId: string;
  transcriptPath: string;
  trigger?: "manual" | "auto";
  customInstructions?: string;
}

export interface PostCompactCtx {
  sessionId: string;
  transcriptPath: string;
  trigger: "manual" | "auto";
}

export interface TaskCreatedCtx {
  taskId: string;
  subject: string;
  description: string;
  sessionId: string;
}

export interface TaskCompletedCtx {
  taskId: string;
  subject: string;
  description: string;
  sessionId: string;
}

export interface SessionStartCtx {
  sessionId: string;
  cwd: string;
  source: "startup" | "resume" | "clear" | "compact";
  model?: string;
  sessionTitle?: string;
}

export interface SessionEndCtx {
  sessionId: string;
  cwd: string;
  reason: SessionEndReason;
}

export interface SubagentStartCtx {
  sessionId: string;
  subagentId: string;
  agentType: string;
}

export interface PermissionRequestCtx {
  toolName: string;
  toolInput: unknown;
  permissionSuggestions?: unknown[];
  sessionId: string;
  cwd: string;
}

export interface PermissionDeniedCtx {
  toolName: string;
  toolInput: string;
  toolUseId: string;
  reason: string;
}

export interface TeammateIdleCtx {
  teammateName: string;
  teamName: string;
  sessionId: string;
  cwd: string;
}

export interface ElicitationCtx {
  mcpServerName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  sessionId: string;
  cwd: string;
}

export interface ElicitationResultCtx {
  mcpServerName: string;
  elicitationId?: string;
  mode?: "form" | "url";
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
  sessionId: string;
  cwd: string;
}

export interface ConfigChangeCtx {
  source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills";
  filePath?: string;
  sessionId: string;
  cwd: string;
}

export interface InstructionsLoadedCtx {
  filePath: string;
  memoryType: "User" | "Project" | "Local" | "Managed";
  loadReason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact";
  globs?: string[];
  triggerFilePath?: string;
  parentFilePath?: string;
  sessionId: string;
  cwd: string;
}

export interface CwdChangedCtx {
  oldCwd: string;
  newCwd: string;
  sessionId: string;
  cwd: string;
}

export interface DirectoryAddedCtx {
  directory: string;
  source: string;
  sessionId: string;
  cwd: string;
}

export interface MessageDisplayCtx {
  turnId: string;
  messageId: string;
  index: number;
  final: boolean;
  delta: string;
  sessionId: string;
  cwd: string;
}

export interface SetupCtx {
  hook_event_name: "Setup";
  trigger: "init" | "maintenance";
}

export interface NotificationCtx {
  hook_event_name: "Notification";
  message: string;
  notification_type: string;
  title?: string;
}

export type FileChangedEventKind = "change" | "add" | "unlink";

export interface FileChangedCtx {
  hook_event_name: "FileChanged";
  file_path: string;
  event: FileChangedEventKind;
}

/** WorktreeCreate input: first nonempty stdout line is the worktree path. */
export interface WorktreeCreateCtx {
  hook_event_name: "WorktreeCreate";
  name: string;
}

export interface WorktreeRemoveCtx {
  hook_event_name: "WorktreeRemove";
  worktree_path: string;
}

export type EventCtx =
  | { kind: "preToolUse"; ctx: PreToolUseCtx }
  | { kind: "postToolUseFailure"; ctx: PostToolUseFailureCtx }
  | { kind: "postToolBatch"; ctx: PostToolBatchCtx }
  | { kind: "userPromptExpansion"; ctx: UserPromptExpansionCtx }
  | { kind: "stopFailure"; ctx: StopFailureCtx }
  | { kind: "permissionRequest"; ctx: PermissionRequestCtx }
  | { kind: "teammateIdle"; ctx: TeammateIdleCtx }
  | { kind: "elicitation"; ctx: ElicitationCtx }
  | { kind: "elicitationResult"; ctx: ElicitationResultCtx }
  | { kind: "configChange"; ctx: ConfigChangeCtx }
  | { kind: "instructionsLoaded"; ctx: InstructionsLoadedCtx }
  | { kind: "cwdChanged"; ctx: CwdChangedCtx }
  | { kind: "directoryAdded"; ctx: DirectoryAddedCtx }
  | { kind: "messageDisplay"; ctx: MessageDisplayCtx }
  | { kind: "sessionStart"; ctx: SessionStartCtx }
  | { kind: "sessionEnd"; ctx: SessionEndCtx }
  | { kind: "subagentStart"; ctx: SubagentStartCtx }
  | { kind: "permissionDenied"; ctx: PermissionDeniedCtx }
  | { kind: "Setup"; ctx: SetupCtx }
  | { kind: "Notification"; ctx: NotificationCtx }
  | { kind: "FileChanged"; ctx: FileChangedCtx }
  | { kind: "WorktreeCreate"; ctx: WorktreeCreateCtx }
  | { kind: "WorktreeRemove"; ctx: WorktreeRemoveCtx }
  | { kind: "postToolUse"; ctx: PostToolUseCtx }
  | { kind: "userPromptSubmit"; ctx: UserPromptSubmitCtx }
  | { kind: "stop"; ctx: StopCtx }
  | { kind: "subagentStop"; ctx: SubagentStopCtx }
  | { kind: "preCompact"; ctx: PreCompactCtx }
  | { kind: "postCompact"; ctx: PostCompactCtx }
  | { kind: "taskCreated"; ctx: TaskCreatedCtx }
  | { kind: "taskCompleted"; ctx: TaskCompletedCtx };

export function envFor(ev: EventCtx): Record<string, string> {
  switch (ev.kind) {
    case "preToolUse":
      return { TOOL_NAME: ev.ctx.toolName, TOOL_INPUT: ev.ctx.toolInput };
    case "postToolUseFailure":
      return {
        TOOL_NAME: ev.ctx.toolName,
        TOOL_INPUT: stringifyHookValue(ev.ctx.toolInput),
        TOOL_USE_ID: ev.ctx.toolUseId,
        ERROR: ev.ctx.error,
      };
    case "postToolBatch":
      return { TOOL_CALLS: stringifyHookValue(ev.ctx.toolCalls) };
    case "userPromptExpansion":
      return {
        EXPANSION_TYPE: ev.ctx.expansionType,
        COMMAND_NAME: ev.ctx.commandName,
        COMMAND_ARGS: ev.ctx.commandArgs,
        PROMPT: ev.ctx.prompt,
      };
    case "stopFailure":
      return {
        SESSION_ID: ev.ctx.sessionId,
        ERROR: ev.ctx.error,
        ...(ev.ctx.errorDetails !== undefined ? { ERROR_DETAILS: ev.ctx.errorDetails } : {}),
      };
    case "permissionRequest":
      return {
        TOOL_NAME: ev.ctx.toolName,
        TOOL_INPUT: stringifyHookValue(ev.ctx.toolInput),
      };
    case "teammateIdle":
      return { TEAMMATE_NAME: ev.ctx.teammateName, TEAM_NAME: ev.ctx.teamName };
    case "elicitation":
      return { MCP_SERVER_NAME: ev.ctx.mcpServerName, MESSAGE: ev.ctx.message };
    case "elicitationResult":
      return { MCP_SERVER_NAME: ev.ctx.mcpServerName, ACTION: ev.ctx.action };
    case "configChange":
      return { SOURCE: ev.ctx.source };
    case "instructionsLoaded":
      return {
        FILE_PATH: ev.ctx.filePath,
        MEMORY_TYPE: ev.ctx.memoryType,
        LOAD_REASON: ev.ctx.loadReason,
      };
    case "cwdChanged":
      return { OLD_CWD: ev.ctx.oldCwd, NEW_CWD: ev.ctx.newCwd };
    case "directoryAdded":
      return { DIRECTORY: ev.ctx.directory, SOURCE: ev.ctx.source };
    case "messageDisplay":
      return {
        TURN_ID: ev.ctx.turnId,
        MESSAGE_ID: ev.ctx.messageId,
        INDEX: String(ev.ctx.index),
        FINAL: String(ev.ctx.final),
        DELTA: ev.ctx.delta,
      };
    case "postToolUse":
      return {
        TOOL_NAME: ev.ctx.toolName,
        TOOL_INPUT: ev.ctx.toolInput,
        TOOL_EXIT: String(ev.ctx.toolExit),
      };
    case "userPromptSubmit":
      return { PROMPT_TEXT: ev.ctx.promptText };
    case "stop":
      return {
        SESSION_ID: ev.ctx.sessionId,
        STOP_HOOK_ACTIVE: ev.ctx.stopHookActive === true ? "true" : "false",
      };
    case "subagentStop":
      return { SESSION_ID: ev.ctx.sessionId, SUBAGENT_ID: ev.ctx.subagentId };
    case "preCompact":
      return {
        SESSION_ID: ev.ctx.sessionId,
        TRANSCRIPT_PATH: ev.ctx.transcriptPath,
      };
    case "postCompact":
      return {
        SESSION_ID: ev.ctx.sessionId,
        TRANSCRIPT_PATH: ev.ctx.transcriptPath,
        TRIGGER: ev.ctx.trigger,
      };
    case "taskCreated":
      return {
        SESSION_ID: ev.ctx.sessionId,
        TASK_ID: ev.ctx.taskId,
        TASK_SUBJECT: ev.ctx.subject,
        TASK_DESCRIPTION: ev.ctx.description,
      };
    case "taskCompleted":
      return {
        SESSION_ID: ev.ctx.sessionId,
        TASK_ID: ev.ctx.taskId,
        TASK_SUBJECT: ev.ctx.subject,
        TASK_DESCRIPTION: ev.ctx.description,
      };
    case "sessionStart":
      return {
        SESSION_ID: ev.ctx.sessionId,
        CWD: ev.ctx.cwd,
        SOURCE: ev.ctx.source,
        ...(ev.ctx.model !== undefined ? { MODEL: ev.ctx.model } : {}),
        ...(ev.ctx.sessionTitle !== undefined ? { SESSION_TITLE: ev.ctx.sessionTitle } : {}),
      };
    case "sessionEnd":
      return {
        SESSION_ID: ev.ctx.sessionId,
        CWD: ev.ctx.cwd,
        REASON: ev.ctx.reason,
      };
    case "subagentStart":
      return {
        SESSION_ID: ev.ctx.sessionId,
        SUBAGENT_ID: ev.ctx.subagentId,
        AGENT_TYPE: ev.ctx.agentType,
      };
    case "permissionDenied":
      return {
        TOOL_NAME: ev.ctx.toolName,
        TOOL_INPUT: ev.ctx.toolInput,
        TOOL_USE_ID: ev.ctx.toolUseId,
        REASON: ev.ctx.reason,
      };
    case "Setup":
      return { TRIGGER: ev.ctx.trigger };
    case "Notification":
      return {
        MESSAGE: ev.ctx.message,
        NOTIFICATION_TYPE: ev.ctx.notification_type,
        ...(ev.ctx.title !== undefined ? { TITLE: ev.ctx.title } : {}),
      };
    case "FileChanged":
      return {
        FILE_PATH: ev.ctx.file_path,
        EVENT: ev.ctx.event,
      };
    case "WorktreeCreate":
      return {
        HOOK_EVENT_NAME: "WorktreeCreate",
        WORKTREE_NAME: ev.ctx.name,
        NAME: ev.ctx.name,
      };
    case "WorktreeRemove":
      return {
        HOOK_EVENT_NAME: "WorktreeRemove",
        WORKTREE_PATH: ev.ctx.worktree_path,
      };
  }
}

function stringifyHookValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
