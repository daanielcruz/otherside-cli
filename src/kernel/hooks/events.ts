export const HOOK_EVENT_VALUES = [
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "stop",
  "subagentStop",
  "preCompact",
  "postCompact",
  "taskCreated",
  "taskCompleted",
  "sessionStart",
  "sessionEnd",
  "subagentStart",
  "permissionDenied",
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

export interface PreToolUseCtx {
  toolName: string;
  toolInput: string;
}

export interface PostToolUseCtx {
  toolName: string;
  toolInput: string;
  toolExit: number;
}

export interface UserPromptSubmitCtx {
  promptText: string;
}

export interface StopCtx {
  sessionId: string;
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

export interface PermissionDeniedCtx {
  toolName: string;
  toolInput: string;
  toolUseId: string;
  reason: string;
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
    case "postToolUse":
      return {
        TOOL_NAME: ev.ctx.toolName,
        TOOL_INPUT: ev.ctx.toolInput,
        TOOL_EXIT: String(ev.ctx.toolExit),
      };
    case "userPromptSubmit":
      return { PROMPT_TEXT: ev.ctx.promptText };
    case "stop":
      return { SESSION_ID: ev.ctx.sessionId };
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
