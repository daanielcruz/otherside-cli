import {
  fail,
  notify,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  success,
} from "@/design/bridge/envelope.ts";
import { scrub } from "@/design/bridge/scrubber.ts";
import {
  DESIGN_AGENT_TOOLS,
  GenerateImageDesignTool,
  isDesignUploadImagePath,
} from "@/design/capabilities/design-agent-tools.ts";
import {
  CreateDesignTool,
  ReadDesignTool,
  UpdateDesignTool,
} from "@/design/capabilities/design-tools.ts";
import {
  clearVerificationQueue,
  ReadyForVerificationTool,
} from "@/design/capabilities/verification-tools.ts";
import { registerDesignFork, unregisterDesignFork } from "@/design/fork-context.ts";
import { DESIGN_FORK_BODY } from "@/design/harness.ts";
import { buildDesignHistory } from "@/design/history.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { isValidDesignId, loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import { DESIGN_STREAM_TOOL_INPUTS, DesignStreamPreview } from "@/design/stream-preview.ts";
import {
  appendDesignText,
  beginDesignTextSegments,
  clearDesignTextSegments,
  clearDesignTurnIndex,
  currentDesignTextSegment,
  designToolPreview,
  flushDesignText,
  PREVIEWLESS_TOOLS,
  previewlessDonePreview,
  recordToolEnd,
  recordToolStart,
  setDesignTurnIndex,
} from "@/design/tool-cards.ts";
import {
  drainDesignSteers,
  registerDesignTurn,
  steerDesignTurn,
  unregisterDesignTurn,
} from "@/design/turns.ts";
import type {
  DesignCapability,
  DesignSnapshot,
  DesignSnapshotFile,
  DesignSnapshotMessage,
  RpcContext,
} from "@/design/types.ts";
import { drainVerificationQueue, VERIFIER_TOOL_NAMES } from "@/design/verifier.ts";
import { writeDebugError } from "@/devtools/output.ts";
import {
  type PermissionResolver,
  runWithPermissionResolver,
} from "@/engine/agents/agent-context.ts";
import {
  runForkLoopExternal,
  type SubagentResult,
} from "@/engine/background/subagents/dispatcher.ts";
import { canSendNatively } from "@/engine/model/capabilities-runtime.ts";
import { resolveImageGeneratorProvider } from "@/engine/providers/image-generation.ts";
import * as providers from "@/engine/providers/registry.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import { isWorkspaceRead } from "@/engine/queue/runtime/permission-resolution.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { describeImageViaProvider } from "@/engine/tools/builtins/parse-image.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import {
  extractBaseCommand,
  isReadOnlyBashCommand,
  splitCommandParts,
} from "@/engine/tools/index.ts";
import { streamWithRetry } from "@/engine/transport/retry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { ask as askPermission } from "@/kernel/permissions/bridge.ts";
import {
  permissionInputForCall,
  permissionKeyForCall,
  permissionRuleValueFromString,
  RuleStore,
} from "@/kernel/permissions/index.ts";
import { loadRules, saveRules } from "@/kernel/permissions/persist.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { DrainedQueuedMessage, ForkEvent } from "@/kernel/std/types/events.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { Message, ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { hasCredentialSync } from "@/kernel/storage/credentials.ts";

const DESIGN_WORKER_TOOLS: readonly ToolHandler[] = [
  CreateDesignTool,
  ReadDesignTool,
  UpdateDesignTool,
  ReadyForVerificationTool,
  ...DESIGN_AGENT_TOOLS,
];
const DESIGN_WORKER_TOOL_NAMES = DESIGN_WORKER_TOOLS.map((tool) => tool.schema.name);
const DESIGN_ALLOW_SET = new Set([...DESIGN_WORKER_TOOL_NAMES, "ToolSearch"]);
const DESIGN_WORKER_TOOL_DECLARATIONS = DESIGN_WORKER_TOOLS.map((tool) => ({
  name: tool.schema.name,
  description: tool.schema.description,
  input_schema: tool.schema.inputSchema,
}));

type DesignToolDeclaration = (typeof DESIGN_WORKER_TOOL_DECLARATIONS)[number];

// Continuation rounds after the main fork ends: each round drains the screens
// queued by ready_for_verification, runs the background verifier per screen,
// and — on needs_work — wakes the design fork once with the findings.
const MAX_VERIFICATION_ROUNDS = 3;
const NEEDS_WORK_STREAK_NUDGE = 3;

function buildDirectives(opts: {
  codebaseAttached: boolean;
  medium?: string | undefined;
  activeSkills?: readonly string[] | undefined;
  targetScreen?: string | undefined;
}): string {
  const lines: string[] = [];
  if (opts.medium && opts.medium !== "auto") {
    lines.push(`Selected medium: ${opts.medium}. Build that medium; don't ask which one to make.`);
  }
  if (opts.activeSkills && opts.activeSkills.length > 0) {
    lines.push(
      `The user activated these skills: ${opts.activeSkills.join(", ")}. Load each with read_design_skill and apply its methodology alongside the medium.`,
    );
  }
  if (opts.codebaseAttached) {
    lines.push(
      "A codebase is attached: you have Read and Bash. Inspect the working directory (ls, find, grep, read key files) to identify the framework, structure, and existing styles or components before designing. Never ask for facts you can discover yourself. If real product decisions remain, call ask_questions once with one titled form and wait for the returned answers before planning or building; skip it for small edits, follow-ups, and briefs that already settle the decisions.",
    );
    lines.push(
      "After creating the initial design, request a visual review or verify your work if possible. Check your work against the prompt and do a targeted update_design to fix any unpolished aspects or bugs.",
    );
  }
  if (opts.targetScreen) {
    lines.push(
      `The user has the screen "${opts.targetScreen}" selected — apply this request to that screen with update_design unless they name another screen.`,
    );
  }
  if (lines.length === 0) return "";
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>\n\n`;
}

interface DesignToolset {
  scopedTools: readonly ToolHandler[];
  declarations: DesignToolDeclaration[];
  allowSet: Set<string>;
}

async function generateImageAvailable(provider: string): Promise<boolean> {
  const config = await loadConfig();
  const generator = resolveImageGeneratorProvider(config.imageGenProvider, provider);
  return generator !== null && hasCredentialSync(generator);
}

async function resolveDesignToolset(
  provider: string,
  codebaseAttached: boolean,
): Promise<DesignToolset> {
  const allowSet = new Set(DESIGN_ALLOW_SET);
  allowSet.add("ask_questions");
  if (codebaseAttached) {
    allowSet.add("Read");
    allowSet.add("Bash");
  }
  if (!(await generateImageAvailable(provider))) {
    return {
      scopedTools: DESIGN_WORKER_TOOLS,
      declarations: DESIGN_WORKER_TOOL_DECLARATIONS,
      allowSet,
    };
  }
  const scopedTools = [...DESIGN_WORKER_TOOLS, GenerateImageDesignTool];
  allowSet.add(GenerateImageDesignTool.schema.name);
  return {
    scopedTools,
    declarations: scopedTools.map((tool) => ({
      name: tool.schema.name,
      description: tool.schema.description,
      input_schema: tool.schema.inputSchema,
    })),
    allowSet,
  };
}

const READONLY_BASE_COMMANDS = new Set(["find", "grep", "rg", "ls", "cat", "head", "tail"]);
const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "blame",
  "rev-parse",
  "ls-files",
  "describe",
]);

export function isReadOnlyCommand(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !isReadOnlyBashCommand(command)) return false;
  const parts = splitCommandParts(command);
  return parts.every((part) => {
    const base = extractBaseCommand(part).toLowerCase();
    if (base === "git") {
      const tokens = part.trim().split(/\s+/);
      const gitIndex = tokens.findIndex((token) => token.toLowerCase() === "git");
      const sub = tokens[gitIndex + 1]?.toLowerCase();
      return sub !== undefined && READONLY_GIT_SUBCOMMANDS.has(sub);
    }
    return READONLY_BASE_COMMANDS.has(base);
  });
}

const designSessionAllows = new Map<string, Set<string>>();

function sessionAllowSet(sessionId: string): Set<string> {
  let set = designSessionAllows.get(sessionId);
  if (!set) {
    set = new Set<string>();
    designSessionAllows.set(sessionId, set);
  }
  return set;
}

export function clearDesignSessionAllows(sessionId: string): void {
  designSessionAllows.delete(sessionId);
}

export function makeBridgePermissionResolver(
  ctx: RpcContext,
  signal: AbortSignal,
  codebaseRoot: string | null,
  allowedTools: ReadonlySet<string> = DESIGN_ALLOW_SET,
): PermissionResolver {
  const sessionAllowedPatterns = sessionAllowSet(ctx.session.id);

  return async (call: ToolCall) => {
    if (signal.aborted) return "deny";
    if (call.name === "read_image") {
      const path =
        call.input && typeof call.input === "object"
          ? (call.input as Record<string, unknown>).path
          : undefined;
      if (isDesignUploadImagePath(path)) return "allow";
      if (typeof path === "string" && path.startsWith("uploads/")) return "deny";
      if (
        !codebaseRoot ||
        typeof path !== "string" ||
        !isWorkspaceRead("Read", { file_path: path }, codebaseRoot)
      ) {
        return "deny";
      }
    } else if (call.name === "Read") {
      if (!codebaseRoot || !isWorkspaceRead("Read", call.input, codebaseRoot)) return "deny";
    } else if (call.name === "Bash") {
      if (!codebaseRoot || !isReadOnlyCommand(call.input)) return "deny";
    } else if (allowedTools.has(call.name) || VERIFIER_TOOL_NAMES.has(call.name)) {
      return "allow";
    } else {
      return "deny";
    }

    const argsPreview = previewArgs(call.input);
    const ruleInput = permissionInputForCall(call.input, argsPreview);
    const permissionPattern = permissionKeyForCall(call.name, call.input, argsPreview);
    const rules = await loadRules(ctx.cwd);
    const store = new RuleStore();
    store.addAll(rules);
    for (const pattern of sessionAllowedPatterns) {
      const ruleValue = permissionRuleValueFromString(pattern);
      if (ruleValue) {
        store.add({ source: "session", ruleBehavior: "allow", ruleValue });
      }
    }
    const matched = store.match(call.name, ruleInput);
    if (matched === "deny") return "deny";
    if (matched === "allow") return "allow";

    const requestId = uuidv4();
    ctx.emit(
      notify("$/permission-pending", {
        requestId,
        reason: call.name,
        source: "design",
      }),
    );
    try {
      const result = await askPermission(
        {
          toolName: call.name,
          argsPreview,
          rule: permissionPattern,
          input: call.input,
          source: { name: "design" },
          readOnly: call.name === "Read",
        },
        signal,
      );

      for (const update of result.updates) {
        if (update.type !== "addRules") continue;
        if (update.destination === "session") {
          for (const rule of update.rules) {
            if (rule.ruleBehavior !== "allow") continue;
            sessionAllowedPatterns.add(
              rule.ruleValue.ruleContent
                ? `${rule.ruleValue.toolName}:${rule.ruleValue.ruleContent}`
                : rule.ruleValue.toolName,
            );
          }
          continue;
        }
        const nextRules = [...rules];
        for (const rule of update.rules) {
          const dup = nextRules.some(
            (r) =>
              r.source === rule.source &&
              r.ruleBehavior === rule.ruleBehavior &&
              r.ruleValue.toolName === rule.ruleValue.toolName &&
              (r.ruleValue.ruleContent ?? "") === (rule.ruleValue.ruleContent ?? ""),
          );
          if (!dup) nextRules.push(rule);
        }
        if (nextRules.length > rules.length) {
          await saveRules(nextRules, ctx.cwd);
        }
      }

      return result.decision;
    } finally {
      ctx.emit(notify("$/permission-resolved", { requestId, source: "design" }));
    }
  };
}

interface TextBlock {
  type: "text";
  text: string;
}

interface LlmStreamInput {
  designId: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | TextBlock[];
    // Optional client-supplied identity — used for stable snapshot matching
    // when present; older clients omit both and fall back to index matching.
    id?: string;
    createdAt?: string;
  }>;
  attachments?: Array<{ kind: "image"; data: string }>;
  medium?: string;
  activeSkills?: string[];
  codebase?: boolean;
  targetScreen?: string;
  mentionedElements?: Array<{ id: string; tag?: string; path?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

function parseTextBlock(value: unknown): TextBlock | null {
  if (!isRecord(value)) return null;
  if (value.type !== "text") return null;
  if (typeof value.text !== "string") return null;
  return { type: "text", text: value.text };
}

function parseMessage(value: unknown): LlmStreamInput["messages"][number] | null {
  if (!isRecord(value)) return null;
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") return null;
  const identity = {
    ...(typeof value.id === "string" && value.id.length > 0 ? { id: value.id } : {}),
    ...(typeof value.createdAt === "string" && value.createdAt.length > 0
      ? { createdAt: value.createdAt }
      : {}),
  };
  if (typeof value.content === "string") {
    return { role: value.role, content: value.content, ...identity };
  }
  const blocks = parseList(value.content, parseTextBlock);
  if (!blocks) return null;
  return { role: value.role, content: blocks, ...identity };
}

function parseAttachment(
  value: unknown,
): NonNullable<LlmStreamInput["attachments"]>[number] | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "image") return null;
  if (typeof value.data !== "string") return null;
  return { kind: "image", data: value.data };
}

function parseImageDataUri(uri: string): { mediaType: ImageMediaType; data: string } | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(uri);
  const mediaType = match?.[1];
  const data = match?.[2];
  if (!mediaType || !data) return null;
  return { mediaType: mediaType.toLowerCase() as ImageMediaType, data };
}

function hasClientCredential(raw: Record<string, unknown>): boolean {
  return raw.provider !== undefined || raw.model !== undefined || raw.apiKey !== undefined;
}

function parseMentionedElement(value: unknown): { id: string; tag?: string; path?: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  const result: { id: string; tag?: string; path?: string } = { id: value.id };
  if (typeof value.tag === "string" && value.tag.length > 0) result.tag = value.tag;
  if (typeof value.path === "string" && value.path.length > 0) result.path = value.path;
  return result;
}

function parseInput(params: unknown, fallbackDesignId: string): LlmStreamInput | string {
  if (!isRecord(params)) {
    return "params must be an object";
  }
  if (hasClientCredential(params)) return "provider, model, and apiKey are resolved by the CLI";
  const messages = parseList(params.messages, parseMessage);
  if (!messages || messages.length === 0) {
    return "messages must be a non-empty array";
  }
  const designId =
    typeof params.designId === "string" && params.designId.length > 0
      ? params.designId
      : fallbackDesignId;
  if (!isValidDesignId(designId)) return "designId contains unsafe characters";
  const attachments =
    params.attachments === undefined ? undefined : parseList(params.attachments, parseAttachment);
  if (attachments === null) return "attachments contain an invalid entry";
  const medium = typeof params.medium === "string" ? params.medium : undefined;
  const activeSkills = Array.isArray(params.activeSkills)
    ? params.activeSkills.filter((skill): skill is string => typeof skill === "string")
    : undefined;
  const codebase = params.codebase === true;
  const targetScreen =
    typeof params.targetScreen === "string" && params.targetScreen.length > 0
      ? params.targetScreen
      : undefined;

  let mentionedElements: Array<{ id: string; tag?: string; path?: string }> | undefined;
  if (params.mentionedElements !== undefined) {
    if (Array.isArray(params.mentionedElements)) {
      mentionedElements = [];
      for (const item of params.mentionedElements) {
        const parsedItem = parseMentionedElement(item);
        if (parsedItem) {
          mentionedElements.push(parsedItem);
        }
      }
    }
  }

  return {
    designId,
    messages,
    ...(attachments ? { attachments } : {}),
    ...(medium ? { medium } : {}),
    ...(activeSkills && activeSkills.length > 0 ? { activeSkills } : {}),
    ...(codebase ? { codebase } : {}),
    ...(targetScreen ? { targetScreen } : {}),
    ...(mentionedElements ? { mentionedElements } : {}),
  };
}

function messageText(msg: LlmStreamInput["messages"][number]): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((b) => b.text).join("");
}

function visibleMessages(
  messages: LlmStreamInput["messages"],
): Array<{ role: string; content: string; id?: string; createdAt?: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: messageText(message),
      ...(message.id !== undefined ? { id: message.id } : {}),
      ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
    }))
    .filter((message) => message.content.trim().length > 0);
}

export function snapshotMessages(
  messages: LlmStreamInput["messages"],
  existingSnapshot?: DesignSnapshot | undefined,
): DesignSnapshotMessage[] {
  const baseTime = Date.now();
  const existing = existingSnapshot?.messages ?? [];
  const mapped = visibleMessages(messages).map((message, index): DesignSnapshotMessage => {
    const role = message.role === "assistant" ? "assistant" : "user";
    // A client-supplied id is authoritative; the index/content fallback only
    // covers older clients that send messages without identity.
    const byId = message.id !== undefined ? existing.find((m) => m.id === message.id) : undefined;
    const match =
      byId ??
      (existing[index] &&
      existing[index].role === role &&
      existing[index].content === message.content
        ? existing[index]
        : existing.find((m) => m.role === role && m.content === message.content));
    return {
      id: message.id ?? match?.id ?? `design-message-${index}`,
      role,
      content: message.content,
      // Fallback timestamps are offset by index so ordering stays strictly
      // monotonic instead of collapsing onto one shared timestamp.
      createdAt: message.createdAt ?? match?.createdAt ?? new Date(baseTime + index).toISOString(),
      source: "left" as const,
      status: "done" as const,
      // Rebuilding from the client list must not shed persisted-only fields —
      // losing turnIndex degrades that turn's replay to text-only.
      ...(match?.turnIndex !== undefined ? { turnIndex: match.turnIndex } : {}),
    };
  });
  // Interim text segments are CLI-authored and never echoed by the client, so a
  // rebuild from the client list would drop them; re-attach any not already
  // mapped and re-sort by timestamp so each keeps its place among the cards.
  const mappedIds = new Set(mapped.map((message) => message.id));
  const segments = existing.filter(
    (message) => message.segment !== undefined && !mappedIds.has(message.id),
  );
  if (segments.length === 0) return mapped;
  return [...mapped, ...segments].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

const CANVAS_INLINE_CAP = 24000;

function activeScreenSource(
  snapshot: DesignSnapshot,
  screens: DesignSnapshotFile[],
): { path: string; content: string } | undefined {
  const active = snapshot.viewState.activeFileTab;
  const target =
    (active ? screens.find((file) => file.path === active) : undefined) ??
    (screens.length === 1 ? screens[0] : undefined);
  if (!target) return undefined;
  const artifact = snapshot.artifacts.find((entry) => entry.metadata?.path === target.path);
  const content = target.content ?? artifact?.content ?? "";
  return content.length > 0 ? { path: target.path, content } : undefined;
}

function activeSourceBlock(active: { path: string; content: string } | undefined): string[] {
  if (!active) return [];
  if (active.content.length > CANVAS_INLINE_CAP) {
    return [
      "",
      `Active screen "${active.path}" is ${active.content.length} bytes — too large to inline; call read_design({ path: "${active.path}" }) for its exact source before editing.`,
    ];
  }
  return [
    "",
    `Active screen "${active.path}" — current source (edit against THIS exact markup, never from memory):`,
    "```html",
    active.content,
    "```",
  ];
}

function buildCanvasContext(snapshot: DesignSnapshot | undefined): string {
  if (!snapshot) return "";
  const screens = snapshot.files.filter((file) => file.path.endsWith(".html"));
  if (screens.length === 0) {
    return "The canvas is currently empty — no screens exist yet. Use create_design to add the first screen.\n\n";
  }
  const list = screens
    .map((file, index) => {
      const artifact = snapshot.artifacts.find((entry) => entry.metadata?.path === file.path);
      const bytes = (file.content ?? artifact?.content ?? "").length;
      const name = file.displayName ?? file.path;
      return `  ${index + 1}. ${file.path} — "${name}" (${bytes} bytes, ${file.status})`;
    })
    .join("\n");
  const activeBlock = activeSourceBlock(activeScreenSource(snapshot, screens));
  return [
    "Current canvas (already built — do not start over):",
    `${screens.length} screen(s) on the canvas:`,
    list,
    "Prior turns' tool activity is replayed in the conversation; use read_design for the current exact source before editing.",
    "Adjust an existing screen via update_design on its path; create_design only for a new screen.",
    "Read a screen's exact source with read_design before editing; a find/replace must match a snippet that appears exactly once.",
    ...activeBlock,
    "",
    "",
  ].join("\n");
}

function sendDeltaSafe(ctx: RpcContext, id: number, segment: number, text: string): boolean {
  const verdict = scrub(text);
  if (!verdict.ok) {
    ctx.emit(notify("$/error", { id, code: "internal_error" }));
    return false;
  }
  // `id` stays numeric (older clients require it); `segment` is an additive
  // field an older web ignores — it composes the bubble key from id + segment so
  // text runs split by a tool boundary render as distinct bubbles.
  ctx.emit(notify("$/delta", { id, segment, text }));
  return true;
}

function setSnapshotMessages(ctx: RpcContext, parsed: LlmStreamInput): void {
  const snapshot = ctx.snapshots.get(parsed.designId);
  if (!snapshot) return;
  const next: DesignSnapshot = {
    ...snapshot,
    messages: snapshotMessages(parsed.messages, snapshot),
    status: "streaming",
    updatedAt: new Date().toISOString(),
  };
  ctx.snapshots.set(parsed.designId, next);
  saveDesignSnapshot(ctx.cwd, next);
}

function completeSnapshot(
  ctx: RpcContext,
  designId: string,
  output: string,
  turnIndex: number,
): void {
  const snapshot = ctx.snapshots.get(designId);
  if (!snapshot) return;
  const updatedAt = new Date().toISOString();
  // The final text is the last iteration's output; interim prose ran before a
  // tool and is already persisted as its own segment. When the turn ends on a
  // tool (empty final text), skip the empty bubble — the segments carry it all.
  const finalMessage: DesignSnapshotMessage[] =
    output.trim().length > 0
      ? [
          {
            id: `design-assistant-${updatedAt}`,
            role: "assistant",
            content: output,
            // Completion time, not turn start: the reply must sort after the user
            // message and the turn's tool cards on rehydrate.
            createdAt: updatedAt,
            source: "left",
            status: "done",
            turnIndex,
          },
        ]
      : [];
  const next: DesignSnapshot = {
    ...snapshot,
    messages: [...snapshot.messages, ...finalMessage],
    status: "completed",
    updatedAt,
  };
  ctx.snapshots.set(designId, next);
  saveDesignSnapshot(ctx.cwd, next);
}

function emitForkEvent(
  ctx: RpcContext,
  streamId: number,
  event: ForkEvent,
  designId: string,
): void {
  if (event.kind === "fork_text_delta") {
    appendDesignText(designId, event.text);
    sendDeltaSafe(ctx, streamId, currentDesignTextSegment(designId), event.text);
    return;
  }
  if (event.kind === "fork_tool_dispatch_start") {
    // The buffered text ran before this tool — flush it as its own message so it
    // keeps its place ahead of the card (and opens a fresh segment for what follows).
    flushDesignText(ctx, designId);
    recordToolStart(ctx, designId, event.toolCallId, event.toolName, event.input, "main");
    // Authored HTML is large and never rendered in the pill — the HTML-authoring
    // tools ship only a tiny { path?, title? } descriptor instead of their input.
    const preview = designToolPreview(event.toolName, event.input);
    ctx.emit(
      notify("$/tool", {
        id: event.toolCallId,
        name: event.toolName,
        phase: "running",
        lane: "main",
        ...(preview !== undefined ? { preview } : {}),
      }),
    );
    return;
  }
  if (event.kind === "fork_tool_dispatch_complete") {
    recordToolEnd(
      ctx,
      designId,
      event.toolCallId,
      event.toolName,
      event.isError,
      event.content,
      "main",
    );
    const preview = PREVIEWLESS_TOOLS.has(event.toolName)
      ? previewlessDonePreview(event.isError ? undefined : event.content)
      : event.content;
    ctx.emit(
      notify("$/tool", {
        id: event.toolCallId,
        name: event.toolName,
        phase: event.isError ? "error" : "done",
        lane: "main",
        ...(preview !== undefined ? { preview } : {}),
      }),
    );
    return;
  }
  if (event.kind === "fork_quota_exhausted") {
    ctx.emit(
      notify("$/error", {
        id: streamId,
        code: "quota_exhausted",
        rateLimit: event.message,
      }),
    );
  }
}

// Fork-loop failures carry raw internals ("fork error: …", "quota exhausted for …")
// or nothing at all; the web client renders this string in an error banner, so map
// it to something specific and actionable before it goes over the wire.
export function designTurnFailureMessage(
  result: Pick<SubagentResult, "output" | "quotaExhausted">,
  provider: string,
  model: string,
): string {
  const quota = result.quotaExhausted;
  if (quota !== undefined) {
    return `Provider usage limit reached (${quota.provider}/${quota.model}). Switch the model in the CLI or wait for the limit to reset.`;
  }
  const output = result.output.trim();
  if (/^stalled — no progress for \d+ms$/.test(output)) return output;
  return `The model stream failed (${provider}/${model}). Try again.`;
}

// One needs_work continuation: the verifier findings arrive as a user turn so
// the design fork wakes with its full structured history and fixes the issues.
async function runVerificationRounds(args: {
  ctx: RpcContext;
  designId: string;
  streamId: number;
  requestContext: RequestContext;
  toolset: DesignToolset;
  turnIndex: number;
}): Promise<void> {
  const { ctx, designId, streamId, requestContext, toolset, turnIndex } = args;
  const turnSignal = requestContext.abortSignal;
  const needsWorkStreak = new Map<string, number>();
  // One extra pass beyond the repair budget: the last repair's fixes still get
  // verified (their verdict lands on the timeline) even though no further
  // repair round is spent on them.
  for (let round = 0; round <= MAX_VERIFICATION_ROUNDS; round += 1) {
    if (turnSignal?.aborted) return;
    const findings = await drainVerificationQueue({ ctx, designId, requestContext });
    if (findings.length === 0) return;
    if (round === MAX_VERIFICATION_ROUNDS) return;
    for (const finding of findings) {
      needsWorkStreak.set(finding.path, (needsWorkStreak.get(finding.path) ?? 0) + 1);
    }
    const blocks = findings.map(
      (finding) =>
        `<verifier-result verdict="needs_work">\n${finding.description}\n</verifier-result>`,
    );
    const stuck = findings.some(
      (finding) => (needsWorkStreak.get(finding.path) ?? 0) >= NEEDS_WORK_STREAK_NUDGE,
    );
    const nudge = stuck
      ? "\n\nThis file has come back needs_work several times in a row — incremental tweaks are not converging. State the root cause in one sentence, make ONE decisive edit targeting that cause, and do not tweak the same numeric property again."
      : "";
    const snapshot = resolveSnapshot(ctx, designId);
    const history = buildDesignHistory(
      snapshot,
      (snapshot?.messages ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );
    const prompt = `${buildCanvasContext(snapshot)}${blocks.join("\n\n")}${nudge}`;
    const streamPreview = new DesignStreamPreview(ctx, designId);
    let roundForkId: string | null = null;
    const sink = (event: ForkEvent): void => {
      streamPreview.handle(event);
      if (event.kind === "fork_start") {
        roundForkId = event.forkId;
        registerDesignFork(event.forkId, {
          designId,
          cwd: ctx.cwd,
          snapshots: ctx.snapshots,
          emit: ctx.emit,
        });
        return;
      }
      // The turn's RPC already responded and its stream ended — tool and error
      // events still flow as notifications, but text deltas have no channel.
      if (event.kind === "fork_text_delta") return;
      emitForkEvent(ctx, streamId, event, designId);
    };
    try {
      const result = await runForkLoopExternal({
        ctx: requestContext,
        name: "design",
        body: DESIGN_FORK_BODY,
        allowSet: toolset.allowSet,
        deferredAllow: toolset.allowSet.has("Read") ? new Set(["Bash", "Read"]) : new Set<string>(),
        description: "Design verification follow-up",
        extraDeclarations: toolset.declarations,
        scopedTools: toolset.scopedTools,
        prompt,
        initialMessages: [...history, { role: "user", content: [{ type: "text", text: prompt }] }],
        streamToolInputFor: DESIGN_STREAM_TOOL_INPUTS,
        sink,
      });
      if (!result.isError && result.output.trim().length > 0) {
        completeSnapshot(ctx, designId, result.output, turnIndex);
      }
    } catch {
      return;
    } finally {
      streamPreview.rollbackAll();
      if (roundForkId) unregisterDesignFork(roundForkId);
    }
  }
}

const ONE_SHOT_COMPLETION_TIMEOUT_MS = 60_000;

export async function executeOneShotCompletion(
  requestContext: RequestContext,
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const provider = providers.get(requestContext.provider);
  const harness: ComposedHarness = {
    layers: [{ name: "one-shot-completion", body: systemPrompt }],
    combined: systemPrompt,
    systemBlocks: [{ text: systemPrompt }],
    userPrepend: [],
  };
  const request: Message = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
  };
  const composed = provider.composeMessages(harness, [request]);
  // The turn's signal may already be aborted by the time this background
  // completion runs — swap it for a standalone timeout so a stalled provider
  // can't hang title generation or llm.complete forever.
  const { abortSignal, ...oneShotCtxRest } = requestContext;
  const oneShotCtx: RequestContext = {
    ...oneShotCtxRest,
    abortSignal: AbortSignal.timeout(ONE_SHOT_COMPLETION_TIMEOUT_MS),
  };
  const originalBody = provider.translateRequest(oneShotCtx, composed, []);

  const body = { ...(originalBody as Record<string, unknown>) };
  body.max_tokens = maxTokens ?? 512;
  body.thinking = { type: "disabled" };
  body.temperature = temperature ?? 0.7;
  body.tools = [];

  let text = "";
  for await (const ev of streamWithRetry(oneShotCtx, provider, body)) {
    if (ev.kind === "text_delta") text += ev.text;
    if (ev.kind === "stream_reset") text = "";
    if (ev.kind === "error" || ev.kind === "quota_exhausted") break;
    if (ev.kind === "message_stop") break;
  }
  return text;
}

const PLACEHOLDER_DESIGN_TITLES: ReadonlySet<string> = new Set(["", "Untitled", "Untitled design"]);

// Memory-first snapshot lookup with a disk fallback. Seeding the in-memory map
// on a disk hit is load-bearing: the fork's design tools read ctx.snapshots, so
// without the seed a design opened after a CLI restart hits "no such screen"
// and the model rebuilds from scratch over the persisted work.
function resolveSnapshot(ctx: RpcContext, designId: string): DesignSnapshot | undefined {
  const inMemory = ctx.snapshots.get(designId);
  if (inMemory) return inMemory;
  const fromDisk = loadDesignSnapshot(ctx.cwd, designId);
  if (!fromDisk) return undefined;
  ctx.snapshots.set(designId, fromDisk);
  return fromDisk;
}

async function generateAndSaveDesignTitle(
  ctx: RpcContext,
  requestContext: RequestContext,
  designId: string,
  userPrompt: string,
): Promise<void> {
  try {
    const systemPrompt =
      "Generate a short title of 2 to 5 words for the user's project based on their prompt. Output only the title, with no quotes, no markdown, and no leading/trailing punctuation.";
    const titleText = await executeOneShotCompletion(
      requestContext,
      systemPrompt,
      userPrompt,
      50,
      0.7,
    );

    const title = titleText
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (title.length > 0) {
      const snapshot = ctx.snapshots.get(designId) ?? loadDesignSnapshot(ctx.cwd, designId);
      // The snapshot ships a placeholder title, so a bare truthy check never fires;
      // treat the placeholders as "no real title yet" so generation can land.
      if (snapshot && PLACEHOLDER_DESIGN_TITLES.has(snapshot.title ?? "")) {
        snapshot.title = title;
        // Mark the title as machine-generated so the web can render it with a
        // distinct treatment until the user renames it.
        snapshot.titleIsAuto = true;
        snapshot.updatedAt = new Date().toISOString();
        ctx.snapshots.set(designId, snapshot);
        saveDesignSnapshot(ctx.cwd, snapshot);
        ctx.emit(notify("$/project-mutated", { title, isAutoTitle: true }));
      }
    }
  } catch {
    // Silent fail
  }
}

async function handle(params: unknown, ctx: RpcContext, id: number | string | null): Promise<void> {
  const parsed = parseInput(params, ctx.activeDesignId ?? "");
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  // resolveSnapshot (not a bare Map check) so a design that only exists on disk
  // after a CLI restart is seeded into memory instead of rejected.
  if (!resolveSnapshot(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown designId"));
    return;
  }

  const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === "user");
  const lastUserText = lastUserMsg ? messageText(lastUserMsg) : "";
  if (steerDesignTurn(parsed.designId, lastUserText)) {
    setSnapshotMessages(ctx, parsed);
    ctx.send(success(id, { steered: true }));
    return;
  }

  const broker = ctx.broker.read();
  const streamId = typeof id === "number" ? id : Date.now();
  const abortController = new AbortController();
  const streamPreview = new DesignStreamPreview(ctx, parsed.designId);
  let activeForkId: string | null = null;
  setSnapshotMessages(ctx, parsed);
  registerDesignTurn(parsed.designId, abortController);
  // A stale queue from an aborted turn must not leak verifier runs into this one.
  clearVerificationQueue(parsed.designId);
  // 0-based index of the user-turn now starting: prior user messages precede
  // the current one in params.messages, so it's the user count minus one. Tool
  // cards recorded during this run and the closing assistant message are all
  // stamped with it so history replay can put them back in the right turn.
  const turnIndex = Math.max(
    0,
    visibleMessages(parsed.messages).filter((message) => message.role === "user").length - 1,
  );
  setDesignTurnIndex(parsed.designId, turnIndex);
  beginDesignTextSegments(parsed.designId);
  ctx.emit(notify("$/stream", { id: streamId, event: "start" }));
  try {
    const codebaseRoot = parsed.codebase === true ? ctx.codebaseRoot : null;
    const codebaseAttached = codebaseRoot !== null;

    const snapshot = resolveSnapshot(ctx, parsed.designId);
    const targetProvider = (
      snapshot && snapshot.provider !== undefined ? snapshot.provider : broker.provider
    ) as ProviderId;
    const targetModel = snapshot && snapshot.model !== undefined ? snapshot.model : broker.model;
    const targetEffort = (
      snapshot && snapshot.effort !== undefined ? snapshot.effort : broker.effort
    ) as EffortLevel | null;

    const toolset = await resolveDesignToolset(targetProvider, codebaseAttached);
    const requestContext = makeRequestContext(ctx.agent.deps);
    requestContext.cwd = codebaseRoot ?? ctx.cwd;
    requestContext.sessionId = ctx.session.id;
    requestContext.permissionMode = "default";
    requestContext.permissionModeIsFixed = true;
    requestContext.abortSignal = abortController.signal;
    requestContext.provider = targetProvider;
    requestContext.model = targetModel;
    requestContext.effort = targetEffort;

    if (snapshot && PLACEHOLDER_DESIGN_TITLES.has(snapshot.title ?? "")) {
      const firstUserMsg = parsed.messages.find((m) => m.role === "user");
      if (firstUserMsg) {
        const userPrompt = messageText(firstUserMsg);
        generateAndSaveDesignTitle(ctx, requestContext, parsed.designId, userPrompt).catch(
          () => {},
        );
      }
    }

    const resolver = makeBridgePermissionResolver(
      ctx,
      abortController.signal,
      codebaseRoot,
      toolset.allowSet,
    );
    const result = await runWithPermissionResolver(resolver, async () => {
      const msgs = visibleMessages(parsed.messages);
      if (parsed.mentionedElements && parsed.mentionedElements.length > 0) {
        const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
        if (lastUserMsg) {
          let suffix = "";
          for (const elem of parsed.mentionedElements) {
            suffix += `\n\n<mentioned-element>\nid: ${elem.id}\n`;
            if (elem.tag) {
              suffix += `tag: ${elem.tag}\n`;
            }
            if (elem.path) {
              suffix += `dom: ${elem.path}\n`;
            }
            suffix += "</mentioned-element>";
          }
          lastUserMsg.content += suffix;
        }
      }
      const canvasContext = buildCanvasContext(resolveSnapshot(ctx, parsed.designId));
      const directives = buildDirectives({
        codebaseAttached,
        medium: parsed.medium,
        activeSkills: parsed.activeSkills,
        targetScreen: parsed.targetScreen,
      });
      // Split the transcript: everything before the last user message replays
      // structurally (with each turn's persisted tool_use/tool_result blocks)
      // as initialMessages; only the current user message rides the prompt,
      // composed with canvas context and directives exactly as before.
      let currentIndex = -1;
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === "user") {
          currentIndex = i;
          break;
        }
      }
      const priorMessages = currentIndex >= 0 ? msgs.slice(0, currentIndex) : msgs.slice(0, -1);
      const currentText =
        (currentIndex >= 0 ? msgs[currentIndex]?.content : msgs[msgs.length - 1]?.content) ?? "";
      const history = buildDesignHistory(resolveSnapshot(ctx, parsed.designId), priorMessages);
      const promptText = `${canvasContext}${directives}${currentText}`;
      const withHistory = (blocks: Message["content"]): Message[] => [
        ...history,
        { role: "user", content: blocks },
      ];
      const images = (parsed.attachments ?? [])
        .map((a) => parseImageDataUri(a.data))
        .filter((img): img is { mediaType: ImageMediaType; data: string } => img !== null);
      const toDrainedMessage = (text: string): DrainedQueuedMessage => ({
        text,
        blocks: [{ type: "text", text }],
      });
      const sharedSpec = {
        ctx: requestContext,
        name: "design",
        body: DESIGN_FORK_BODY,
        allowSet: toolset.allowSet,
        deferredAllow: codebaseAttached ? new Set(["Bash", "Read"]) : new Set<string>(),
        description: "Design canvas turn",
        extraDeclarations: toolset.declarations,
        scopedTools: toolset.scopedTools,
        pendingUserInputDrainer: () => drainDesignSteers(parsed.designId).map(toDrainedMessage),
        streamToolInputFor: DESIGN_STREAM_TOOL_INPUTS,
        sink: (event: ForkEvent) => {
          streamPreview.handle(event);
          if (event.kind === "fork_start") {
            activeForkId = event.forkId;
            registerDesignFork(event.forkId, {
              designId: parsed.designId,
              cwd: ctx.cwd,
              snapshots: ctx.snapshots,
              emit: ctx.emit,
            });
          }
          emitForkEvent(ctx, streamId, event, parsed.designId);
        },
      };
      if (images.length > 0 && canSendNatively(targetProvider, targetModel)) {
        const initialMessages = withHistory([
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType,
              data: img.data,
            },
          })),
          { type: "text" as const, text: promptText },
        ]);
        return runForkLoopExternal({ ...sharedSpec, prompt: promptText, initialMessages });
      }
      if (images.length > 0) {
        const descriptions: string[] = [];
        for (const img of images) {
          const described = await describeImageViaProvider(
            requestContext,
            { data: img.data, mediaType: img.mediaType },
            "Describe this attached image in detail so it can inform a UI/design task.",
          );
          if ("text" in described) descriptions.push(described.text);
        }
        const finalPrompt =
          descriptions.length > 0
            ? `${promptText}\n\nAttached image(s):\n${descriptions.join("\n\n")}`
            : promptText;
        if (history.length === 0) {
          return runForkLoopExternal({ ...sharedSpec, prompt: finalPrompt });
        }
        return runForkLoopExternal({
          ...sharedSpec,
          prompt: finalPrompt,
          initialMessages: withHistory([{ type: "text", text: finalPrompt }]),
        });
      }
      // No prior turns: keep the original prompt-only spec so the first turn's
      // provider-specific user-block composition stays exactly as before.
      if (history.length === 0) {
        return runForkLoopExternal({ ...sharedSpec, prompt: promptText });
      }
      return runForkLoopExternal({
        ...sharedSpec,
        prompt: promptText,
        initialMessages: withHistory([{ type: "text", text: promptText }]),
      });
    });
    if (result.isError) {
      writeDebugError("design fork failed", result.output);
      ctx.emit(notify("$/stream", { id: streamId, event: "end" }));
      ctx.send(
        fail(id, RPC_INTERNAL_ERROR, designTurnFailureMessage(result, targetProvider, targetModel)),
      );
      return;
    }
    completeSnapshot(ctx, parsed.designId, result.output, turnIndex);
    ctx.emit(notify("$/stream", { id: streamId, event: "end" }));
    ctx.send(
      success(id, {
        text: result.output,
        provider: targetProvider,
        model: targetModel,
        // The final text is the last segment; the completion must update THAT
        // bubble, not segment 0's (which holds pre-tool prose). Matches the live
        // $/delta id so the intro bubble survives the turn's completion.
        segment: currentDesignTextSegment(parsed.designId),
        usage:
          result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : undefined,
      }),
    );
    try {
      // Screens the model queued via ready_for_verification get their background
      // verifier now; needs_work findings wake the design fork, bounded rounds.
      await runWithPermissionResolver(resolver, () =>
        runVerificationRounds({
          ctx,
          designId: parsed.designId,
          streamId,
          requestContext,
          toolset,
          turnIndex,
        }),
      );
    } catch {
      // Best-effort: the RPC already responded and the stream ended, so a
      // failed verification pass has no client channel — never fail the turn.
    }
  } catch (error) {
    writeDebugError("design stream failed", error);
    ctx.emit(notify("$/stream", { id: streamId, event: "end" }));
    ctx.send(fail(id, RPC_INTERNAL_ERROR, "stream failed"));
  } finally {
    streamPreview.rollbackAll();
    clearDesignTurnIndex(parsed.designId);
    clearDesignTextSegments(parsed.designId);
    clearVerificationQueue(parsed.designId);
    unregisterDesignTurn(parsed.designId, abortController);
    if (activeForkId) unregisterDesignFork(activeForkId);
  }
}

export const LlmStreamCapability: DesignCapability = {
  name: "llm.stream",
  rpcMethod: {
    method: "llm.stream",
    handler: handle,
  },
};
