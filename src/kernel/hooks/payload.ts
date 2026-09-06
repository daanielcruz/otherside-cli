import { type EventCtx, envFor, type HookEvent } from "./events.ts";

const WIRE_NAMES: Record<HookEvent, string> = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  postToolBatch: "PostToolBatch",
  userPromptSubmit: "UserPromptSubmit",
  userPromptExpansion: "UserPromptExpansion",
  stop: "Stop",
  stopFailure: "StopFailure",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  postCompact: "PostCompact",
  taskCreated: "TaskCreated",
  taskCompleted: "TaskCompleted",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  subagentStart: "SubagentStart",
  permissionRequest: "PermissionRequest",
  permissionDenied: "PermissionDenied",
  teammateIdle: "TeammateIdle",
  elicitation: "Elicitation",
  elicitationResult: "ElicitationResult",
  configChange: "ConfigChange",
  instructionsLoaded: "InstructionsLoaded",
  cwdChanged: "CwdChanged",
  directoryAdded: "DirectoryAdded",
  messageDisplay: "MessageDisplay",
  Setup: "Setup",
  Notification: "Notification",
  FileChanged: "FileChanged",
  WorktreeCreate: "WorktreeCreate",
  WorktreeRemove: "WorktreeRemove",
};

export function wireNameFor(event: HookEvent): string {
  return WIRE_NAMES[event];
}

export function payloadFor(ev: EventCtx): Record<string, unknown> {
  const out: Record<string, unknown> = { hook_event_name: wireNameFor(ev.kind) };
  for (const [key, value] of Object.entries(envFor(ev))) out[key.toLowerCase()] = value;

  const ctx = ev.ctx as { sessionId?: unknown; transcriptPath?: unknown; cwd?: unknown };
  if (typeof ctx.sessionId === "string") out.session_id = ctx.sessionId;
  if (typeof ctx.transcriptPath === "string") out.transcript_path = ctx.transcriptPath;
  if (typeof ctx.cwd === "string") out.cwd = ctx.cwd;

  switch (ev.kind) {
    case "preToolUse":
      out.tool_input = parseToolInput(ev.ctx.toolInput);
      break;
    case "postToolUse":
      out.tool_input = parseToolInput(ev.ctx.toolInput);
      out.tool_exit = ev.ctx.toolExit;
      assign(out, "tool_response", ev.ctx.toolResponse);
      assign(out, "tool_use_id", ev.ctx.toolUseId);
      assign(out, "duration_ms", ev.ctx.durationMs);
      break;
    case "postToolUseFailure":
      out.tool_input = ev.ctx.toolInput;
      out.tool_use_id = ev.ctx.toolUseId;
      assign(out, "is_interrupt", ev.ctx.isInterrupt);
      assign(out, "duration_ms", ev.ctx.durationMs);
      break;
    case "postToolBatch":
      out.tool_calls = ev.ctx.toolCalls;
      break;
    case "userPromptSubmit":
      out.prompt = ev.ctx.promptText;
      delete out.prompt_text;
      break;
    case "userPromptExpansion":
      assign(out, "command_source", ev.ctx.commandSource);
      break;
    case "stop":
      out.stop_hook_active = ev.ctx.stopHookActive === true;
      break;
    case "stopFailure":
      assign(out, "last_assistant_message", ev.ctx.lastAssistantMessage);
      break;
    case "permissionRequest":
      out.tool_input = ev.ctx.toolInput;
      assign(out, "permission_suggestions", ev.ctx.permissionSuggestions);
      break;
    case "elicitation":
      assign(out, "mode", ev.ctx.mode);
      assign(out, "url", ev.ctx.url);
      assign(out, "elicitation_id", ev.ctx.elicitationId);
      assign(out, "requested_schema", ev.ctx.requestedSchema);
      break;
    case "elicitationResult":
      assign(out, "elicitation_id", ev.ctx.elicitationId);
      assign(out, "mode", ev.ctx.mode);
      assign(out, "content", ev.ctx.content);
      break;
    case "configChange":
      assign(out, "file_path", ev.ctx.filePath);
      break;
    case "instructionsLoaded":
      assign(out, "globs", ev.ctx.globs);
      assign(out, "trigger_file_path", ev.ctx.triggerFilePath);
      assign(out, "parent_file_path", ev.ctx.parentFilePath);
      break;
    case "messageDisplay":
      out.index = ev.ctx.index;
      out.final = ev.ctx.final;
      break;
    default:
      break;
  }

  return out;
}

export function payloadJsonFor(ev: EventCtx): string {
  try {
    return JSON.stringify(payloadFor(ev));
  } catch {
    return JSON.stringify({ hook_event_name: wireNameFor(ev.kind) });
  }
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value;
}
