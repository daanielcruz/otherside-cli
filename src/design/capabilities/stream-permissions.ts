import { notify } from "@/design/bridge/envelope.ts";
import { isDesignUploadImagePath } from "@/design/capabilities/agent-tools.ts";
import { DESIGN_ALLOW_SET } from "@/design/capabilities/stream-tools.ts";
import type { RpcContext } from "@/design/types.ts";
import { VERIFIER_TOOL_NAMES } from "@/design/verifier.ts";
import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import { isWorkspaceRead } from "@/engine/queue/runtime/permission-resolution.ts";
import {
  extractBaseCommand,
  isReadOnlyBashCommand,
  splitCommandParts,
} from "@/engine/tools/index.ts";
import { ask as askPermission } from "@/kernel/permissions/bridge.ts";
import {
  parseRuleValueText,
  permissionInputForCall,
  permissionKeyForCall,
  RuleStore,
} from "@/kernel/permissions/index.ts";
import { loadRules, saveRules } from "@/kernel/permissions/persist.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";

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
      const ruleValue = parseRuleValueText(pattern);
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
            (ruleAtIndex) =>
              ruleAtIndex.source === rule.source &&
              ruleAtIndex.ruleBehavior === rule.ruleBehavior &&
              ruleAtIndex.ruleValue.toolName === rule.ruleValue.toolName &&
              (ruleAtIndex.ruleValue.ruleContent ?? "") === (rule.ruleValue.ruleContent ?? ""),
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
