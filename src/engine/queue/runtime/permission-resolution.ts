import { realpathSync } from "node:fs";
import { currentSpawnedAgentScope } from "@/engine/agents/agent-context.ts";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import { permissionAbortSignal } from "@/engine/tools/permission-abort-context.ts";
import type { PermissionDecision } from "@/engine/tools/pipeline.ts";
import { isActivePlanFileWrite } from "@/engine/tools/plan-gate.ts";
import { preToolUseHookPermissionSignal } from "@/engine/tools/pretooluse-hook-permission-context.ts";
import * as registry from "@/engine/tools/registry.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import { ask as askPermission } from "@/kernel/channels/permission.ts";
import { fireDirectoryAddedHooks, firePermissionRequestHooks } from "@/kernel/hooks/handler.ts";
import { isMcpAuthToolName } from "@/kernel/mcp/auth/dynamic-tools.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import {
  parseRuleValueText,
  permissionInputForCall,
  permissionKeyForCall,
  permissionTargetFieldFromInput,
  RuleStore,
} from "@/kernel/permissions/index.ts";
import {
  loadRules,
  persistAdditionalDirectoryUpdate,
  saveRules,
} from "@/kernel/permissions/persist.ts";
import {
  isAcceptEditsTool,
  isSensitiveWriteApprovable,
} from "@/kernel/permissions/sensitive-paths.ts";
import {
  type PermissionRule,
  type PermissionUpdate,
  serializeRuleValue,
} from "@/kernel/permissions/types.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { previewArgs } from "./args-preview.ts";
import { recordHeadlessDenial } from "./headless-denials.ts";
import { type CompoundBashProbes, compoundBashDecision } from "./permission-bash-compounds.ts";
import {
  bashCdPathDecision,
  bashDangerousRmCriticalPathDecision,
  bashDangerousRmRootVarDecision,
  bashHasWriteCommand,
  bashReadPathDecision,
  bashWritePathDecision,
} from "./permission-bash-paths.ts";
import {
  activeAdditionalWorkingDirectories,
  bashCommandFromInput,
  editFilePathFromInput,
  ensureConfiguredWorkingDirectories,
  enterWorktreeExternalPath,
  filePathRepresentations,
  filesystemReadSessionSuggestions,
  isAcceptEditsBashInWorkingDirectories,
  isAutoMemoryEdit,
  isReadOnlyToolCheck,
  isWorkspaceEdit,
  isWorkspaceRead,
  outsideEditDirectory,
  readFilePathFromInput,
  workflowNameFromInput,
} from "./permission-workspace.ts";
import type { AgentDeps } from "./turn/types.ts";
import { canonicalizeWorkingDirectory, resolveWorkingDirectory } from "./working-directories.ts";

export type { CompoundBashProbes };
export { activeAdditionalWorkingDirectories, compoundBashDecision, isWorkspaceRead };

// Headless (`--print`) has no UI to answer permission prompts. A tool that reaches the interactive ask is auto-denied and recorded, avoiding an indefinite hang from a never-resolving `ask()` call. Accept-edits and yolo grants are already applied before this check, so only genuinely prompt-requiring calls land here.
async function headlessAutoDeny(
  deps: PermissionResolutionDeps,
  call: ToolCall,
): Promise<PermissionDecision> {
  recordHeadlessDenial(deps.agentDeps.session.id, {
    tool_name: call.name,
    tool_use_id: call.id,
    tool_input: isRecord(call.input) ? call.input : {},
  });
  return {
    kind: "deny",
    message:
      "Permission denied: this tool needs interactive approval, unavailable in headless (--print) mode. Re-run with --permission-mode acceptEdits, --allowedTools, or --dangerously-skip-permissions to authorize it.",
  };
}

const DENIAL_WORKAROUND_GUIDANCE =
  "IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, " +
  "e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, " +
  "e.g. do not use your ability to run tests to execute non-test actions. " +
  "You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. " +
  "If you believe this capability is essential to complete the user's request, STOP and explain to the user " +
  "what you were trying to do and why you need this permission. Let the user decide how to proceed.";

function autoRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} has been denied. ${DENIAL_WORKAROUND_GUIDANCE}`;
}

function backgroundAgentAutoDeny(call: ToolCall): PermissionDecision {
  return { kind: "deny", message: autoRejectMessage(call.name) };
}

const PERMISSION_FREE_TOOLS = new Set([
  "Agent",
  "EnterPlanMode",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "ReportFindings",
  "ToolSearch",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  "ScheduleWakeup",
  "SendMessage",
  "StructuredOutput",
  "WaitForMcpServers",
]);

export interface PermissionResolutionDeps {
  agentDeps: AgentDeps;
  injections: InjectionQueue;
  sessionAllowedToolPatterns: Set<string>;
}

// Read live from the broker on every decision — a mode change (shift+tab to
// yolo/plan mid-turn, or a remote client) must apply to the very next tool
// call, never wait for the turn to end. A live yolo/accept-edits beats an
// agent-definition mode pinned at spawn; in every other live mode the pinned
// override governs that agent's run.
function currentPermissionMode(deps: PermissionResolutionDeps): PermissionMode {
  const live = deps.agentDeps.broker.read().permissionMode;
  if (live === "yolo" || live === "accept-edits") return live;
  return currentSpawnedAgentScope()?.permissionModeOverride ?? live;
}

// The set a new session-allow grant is written into. Inside a fork that's the
// fork's own AgentContext set (fresh per fork), never the parent's deps — a
// grant a fork makes for itself during its own run accumulates there (no
// re-prompting within it) without writing back into the parent's set. On the
// main turn (no AgentContext) it's the session's own set directly.
export function activeSessionAllowSet(deps: PermissionResolutionDeps): Set<string> {
  return currentSpawnedAgentScope()?.sessionAllowedToolPatterns ?? deps.sessionAllowedToolPatterns;
}

// The patterns a call is matched against. A fork still honors whatever the
// parent already granted for the session — `deps.sessionAllowedToolPatterns`
// is closed over live from the spawning scope, so this also picks up a grant
// the parent makes *after* the fork started. Layered on top (never replacing it) is the
// fork's own local grants, so an inherited allow can never shadow a grant the
// fork made for itself, and a fork's own grants still don't leak back into
// the parent (see `activeSessionAllowSet`, used for writes). Explicit deny/ask
// rules are matched separately in `resolvePermission` and always take
// precedence over any allow pattern collected here.
export function sessionAllowPatternsForMatch(deps: PermissionResolutionDeps): Iterable<string> {
  const forkLocal = currentSpawnedAgentScope()?.sessionAllowedToolPatterns;
  if (forkLocal === undefined || forkLocal.size === 0) return deps.sessionAllowedToolPatterns;
  if (deps.sessionAllowedToolPatterns.size === 0) return forkLocal;
  return new Set([...deps.sessionAllowedToolPatterns, ...forkLocal]);
}

export async function resolvePermission(
  deps: PermissionResolutionDeps,
  call: ToolCall,
  signal: AbortSignal | undefined = permissionAbortSignal(),
): Promise<PermissionDecision> {
  // Dynamic MCP authenticate/complete_authentication pseudo-tools carry a
  // per-server wire name (mcp__<server>__authenticate), so they can't live in
  // the static PERMISSION_FREE_TOOLS set — matched by wire-name shape
  // instead (MCP-003).
  const permissionFree = PERMISSION_FREE_TOOLS.has(call.name) || isMcpAuthToolName(call.name);
  if (call.name === "EnterPlanMode") return "allow";
  if (call.name === "ExitPlanMode") {
    return resolveExitPlanMode(deps, call, signal);
  }
  await ensureConfiguredWorkingDirectories(deps);
  const argsPreview = previewArgs(call.input);
  const cwd = deps.agentDeps.session.cwd;
  const additionalWorkingDirectories = activeAdditionalWorkingDirectories(deps);
  const handler = registry.get(call.name);
  const requiresUserInteraction = handler?.requiresUserInteraction?.() ?? false;
  const canonicalName = handler?.schema.name ?? call.name;
  const enterWorktreeNeedsAsk =
    canonicalName === "EnterWorktree" && (await enterWorktreeExternalPath(call.input, cwd));
  const workflowName = canonicalName === "Workflow" ? workflowNameFromInput(call.input) : null;
  const ruleInput = workflowName ?? permissionInputForCall(call.input, argsPreview);
  const aliasNames = registry.aliasNamesFor(canonicalName);
  const permissionPattern =
    workflowName === null
      ? permissionKeyForCall(call.name, call.input, argsPreview)
      : `Workflow(${workflowName})`;
  const rules = await loadRules(cwd);
  const store = new RuleStore();
  store.addAll(rules);
  for (const pattern of sessionAllowPatternsForMatch(deps)) {
    const ruleValue = parseRuleValueText(pattern);
    if (ruleValue) {
      store.add({ source: "session", ruleBehavior: "allow", ruleValue });
    }
  }
  const matched = store.match(canonicalName, ruleInput, aliasNames);
  const primaryField = permissionTargetFieldFromInput(call.input);
  const fieldDenyRule = store.matchInputParam(
    canonicalName,
    call.input,
    primaryField,
    "deny",
    aliasNames,
  );
  const fieldAskRule = store.matchInputParam(
    canonicalName,
    call.input,
    primaryField,
    "ask",
    aliasNames,
  );
  const filePath =
    canonicalName === "Read"
      ? readFilePathFromInput(call.input)
      : editFilePathFromInput(canonicalName, call.input);
  const fileRuleToolName = canonicalName === "Read" ? "Read" : "Edit";
  const fileRulePaths = filePath === null ? [] : filePathRepresentations(filePath, cwd, true);
  const matchesFileRule = (behavior: "deny" | "ask") =>
    fileRulePaths.some(
      (path) => store.match(fileRuleToolName, path, [canonicalName, ...aliasNames]) === behavior,
    );
  const fileRuleDenied = matchesFileRule("deny");
  const fileRuleAsked = matchesFileRule("ask");
  if (matched === "deny" || fileRuleDenied || fieldDenyRule !== null) return "deny";
  const hasRuleAsk = matched === "ask" || fileRuleAsked || fieldAskRule !== null;
  const planContext = { sessionId: deps.agentDeps.session.id, cwd };
  if (!hasRuleAsk && call.name === "Write" && isActivePlanFileWrite(call.input, planContext))
    return "allow";
  if (!hasRuleAsk && isAutoMemoryEdit(call.name, call.input, cwd)) return "allow";
  if (permissionFree && !hasRuleAsk && !requiresUserInteraction) return "allow";
  // PERM-HOOK-ALLOW-BYPASS-001: a PreToolUse hook's explicit
  // hookSpecificOutput.permissionDecision:"allow" re-checks only the explicit
  // deny/ask rules just evaluated above and, finding none, resolves straight to allow,
  // bypassing the interactive/headless/background-agent prompt path entirely
  // (askPermission / headlessAutoDeny / backgroundAgentAutoDeny below). A
  // requiresUserInteraction tool (e.g. AskUserQuestion) still owns its own
  // dialog and is excluded here, matching every other bypass above.
  const hookPermission = preToolUseHookPermissionSignal();
  if (
    canonicalName === "EnterWorktree" &&
    !enterWorktreeNeedsAsk &&
    !hasRuleAsk &&
    hookPermission !== "ask" &&
    !requiresUserInteraction
  ) {
    return "allow";
  }
  if (hookPermission === "allow" && !hasRuleAsk && !requiresUserInteraction) return "allow";
  let compound: ReturnType<typeof compoundBashDecision> = null;
  const command = call.name === "Bash" ? bashCommandFromInput(call.input) : null;
  // Ordering: argv-level path safety runs after explicit Bash
  // deny/ask rules but before an allow rule, session grant, or permissive mode.
  const bashPathDecision =
    command === null ? null : bashWritePathDecision(command, cwd, additionalWorkingDirectories);
  const bashReadDecision =
    command === null ? null : bashReadPathDecision(command, cwd, additionalWorkingDirectories);
  const bashCdDecision =
    command === null ? null : bashCdPathDecision(command, cwd, additionalWorkingDirectories);
  const bashDangerousRmDecision = command === null ? null : bashDangerousRmRootVarDecision(command);
  const bashDangerousRmPathDecision =
    command === null
      ? null
      : bashDangerousRmCriticalPathDecision(command, cwd, additionalWorkingDirectories);
  const mode = currentPermissionMode(deps);
  // MCP-PLAN-001: plan mode keeps a write-shaped call bypass-immune to an
  // already-granted allow rule (persisted rule or session grant — both are
  // folded into `matched` above): a mode:'plan' passthrough rewrite for
  // non-readonly MCP tools and the filesystem write gate that runs before
  // the matching allow rule. Only yolo (a distinct, mutually exclusive mode from
  // plan — see currentPermissionMode) ever lets such a call through; a Bash
  // allow rule for a non-filesystem-mutating command (e.g. `npm test:*`)
  // still auto-allows, since only recognized write commands are gated.
  const planModeWriteGate =
    mode === "plan" &&
    (isAcceptEditsTool(call.name) ||
      (command !== null && bashHasWriteCommand(command)) ||
      (isMcpToolName(call.name) && handler?.isConcurrencySafe !== true));
  if (matched !== "ask" && command !== null) {
    compound = compoundBashDecision(command, {
      matchSub: (sub) => store.match(canonicalName, sub, aliasNames),
      subSessionAllowed: () => false,
      subAutoAllowed: (sub) => isReadOnlyBashCommand(sub),
    });
    if (compound === "deny") return "deny";
    if (
      compound === "allow" &&
      !planModeWriteGate &&
      hookPermission !== "ask" &&
      bashPathDecision === null &&
      bashReadDecision === null &&
      bashCdDecision === null &&
      bashDangerousRmDecision === null &&
      bashDangerousRmPathDecision === null
    ) {
      return "allow";
    }
  }
  const mustAsk =
    hasRuleAsk ||
    compound === "rule-ask" ||
    bashDangerousRmDecision === "ask" ||
    bashDangerousRmPathDecision === "ask" ||
    // PERM-HOOK-ALLOW-BYPASS-001: a PreToolUse hook's explicit
    // hookSpecificOutput.permissionDecision:"ask" forces the interactive/
    // headless prompt path even when mode (including yolo) or a matched
    // allow rule would otherwise auto-allow: an explicit hook "ask" forces
    // the prompt path. An explicit deny
    // rule (checked above, before `hookPermission` is even read) still wins,
    // and a requiresUserInteraction tool still owns its own dialog instead of
    // this one (checked further below, unconditionally on `mustAsk`).
    hookPermission === "ask" ||
    (mode !== "yolo" &&
      (enterWorktreeNeedsAsk ||
        bashPathDecision === "ask" ||
        bashReadDecision === "ask" ||
        bashCdDecision === "ask" ||
        compound === "ask" ||
        !isSensitiveWriteApprovable(call.name, call.input, cwd, (path, base) =>
          filePathRepresentations(path, base ?? cwd, true),
        )));
  if (!mustAsk) {
    if (isWorkspaceRead(call.name, call.input, cwd, realpathSync, additionalWorkingDirectories))
      return "allow";
    if (call.name === "Bash" && isReadOnlyToolCheck(call.name, call.input)) return "allow";
    if (matched === "allow" && !requiresUserInteraction && !planModeWriteGate) return "allow";
    if (mode === "yolo" && !requiresUserInteraction) return "allow";
    if (mode === "accept-edits") {
      if (isWorkspaceEdit(call.name, call.input, cwd, additionalWorkingDirectories)) return "allow";
      if (
        command !== null &&
        isAcceptEditsBashInWorkingDirectories(command, cwd, additionalWorkingDirectories)
      )
        return "allow";
    }
  }
  const suggestions =
    canonicalName === "Read"
      ? filesystemReadSessionSuggestions(filePath, cwd, additionalWorkingDirectories)
      : [];
  await firePermissionRequestHooks(deps.agentDeps.config, {
    kind: "permissionRequest",
    ctx: {
      toolName: call.name,
      toolInput: call.input,
      sessionId: deps.agentDeps.session.id,
      cwd,
      ...(suggestions.length > 0 ? { permissionSuggestions: suggestions } : {}),
    },
  });
  const agentContext = currentSpawnedAgentScope();
  // AGENT-PERM-003: a detached named background subagent has no parent turn
  // of its own to answer a prompt, but in an interactive TUI session the
  // permission channel is a session-long duplex the REPL is already
  // subscribed to (prompts are only auto-avoided when there is no live
  // request dialog bound). So auto-deny only when there is no live UI to
  // bubble the ask to; a headless/print or piped run still auto-denies.
  if (agentContext?.shouldAvoidPermissionPrompts === true && getRuntimeKind() !== "interactive")
    return backgroundAgentAutoDeny(call);
  if (getRuntimeKind() === "print") return headlessAutoDeny(deps, call);
  // AskUserQuestion owns the interactive dialog. It must still reach the
  // headless and no-prompt guards above, but does not need a second generic
  // permission approval before showing that dialog.
  if (!hasRuleAsk && requiresUserInteraction) return "allow";
  const result = await askPermission(
    {
      toolName: call.name,
      argsPreview,
      rule: permissionPattern,
      input: call.input,
      readOnly: isReadOnlyToolCheck(call.name, call.input),
      editDirectory: outsideEditDirectory(call.name, call.input, cwd, additionalWorkingDirectories),
      ...(suggestions.length > 0 ? { suggestions } : {}),
      ...(agentContext
        ? { source: { name: agentContext.subagentName, depth: agentContext.depth } }
        : {}),
    },
    signal,
  );
  const feedback = result.feedback?.trim();
  if (result.decision === "deny") {
    // Feedback typed on a rejection rides the denial itself so the model can
    // adjust immediately, instead of waiting a turn for an injection to drain.
    if (feedback && feedback.length > 0) {
      return {
        kind: "deny",
        message: `permission denied\nThe user rejected this tool call with feedback: ${feedback}`,
      };
    }
    return "deny";
  }
  for (const update of result.updates) {
    await applyUpdate(deps, update, { rules, cwd });
  }
  // Feedback typed on an approval arrives after the tool result, at the next
  // continuation boundary — same queue the plan feedback uses.
  if (feedback && feedback.length > 0) {
    deps.injections.push(`[user-feedback-on-tool-approval]\n${feedback}`);
  }
  return result.decision;
}

async function resolveExitPlanMode(
  deps: PermissionResolutionDeps,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<PermissionDecision> {
  if (currentPermissionMode(deps) !== "plan") {
    return {
      kind: "deny",
      message:
        "ExitPlanMode is only valid while in plan mode. If your plan was already approved, continue with the implementation instead.",
    };
  }
  await firePermissionRequestHooks(deps.agentDeps.config, {
    kind: "permissionRequest",
    ctx: {
      toolName: call.name,
      toolInput: call.input,
      sessionId: deps.agentDeps.session.id,
      cwd: deps.agentDeps.session.cwd,
    },
  });
  if (getRuntimeKind() === "print") return await headlessAutoDeny(deps, call);
  const result = await askPermission(
    {
      toolName: call.name,
      argsPreview: previewArgs(call.input),
      rule: null,
      input: call.input,
      bypassAvailable: deps.agentDeps.broker.read().prePlanMode === "yolo",
    },
    signal,
  );
  if (result.decision === "allow") {
    for (const update of result.updates) {
      await applyUpdate(deps, update, { rules: [], cwd: deps.agentDeps.session.cwd });
    }
    return "allow";
  }
  const feedback = result.feedback?.trim();
  if (feedback && feedback.length > 0) {
    deps.injections.push(`[user-feedback-on-plan]\n${feedback}`);
    return {
      kind: "deny",
      message: `User rejected the plan with this feedback: ${feedback}\nUpdate the plan to address it and call ExitPlanMode again.`,
    };
  }
  return {
    kind: "deny",
    message:
      "User wants to revise the plan. Wait for them to describe the changes they want, then update the plan and call ExitPlanMode again.",
  };
}

interface ApplyContext {
  rules: PermissionRule[];
  cwd: string;
}

async function applyUpdate(
  deps: PermissionResolutionDeps,
  update: PermissionUpdate,
  ctx: ApplyContext,
): Promise<void> {
  if (update.type === "setMode") {
    const mode = mapMode(update.mode);
    if (!mode) return;
    const currentMode = currentPermissionMode(deps);
    if (mode === "accept-edits" && currentMode !== "default" && currentMode !== "plan") return;
    deps.agentDeps.broker.dispatch({ kind: "set_permission_mode", mode });
    return;
  }
  if (update.type === "addDirectories") {
    const directories = activeAdditionalWorkingDirectories(deps);
    const added: string[] = [];
    for (const directory of update.dirs) {
      const canonical = canonicalizeWorkingDirectory(directory, ctx.cwd);
      if (canonical === null || directories.has(canonical)) continue;
      directories.add(canonical);
      added.push(canonical);
    }
    await persistAdditionalDirectoryUpdate(added, update.destination ?? "session", ctx.cwd, false);
    for (const directory of added) {
      await fireDirectoryAddedHooks(deps.agentDeps.config, {
        directory,
        source: "permission",
        sessionId: deps.agentDeps.session.id,
        cwd: ctx.cwd,
      });
    }
    return;
  }
  if (update.type === "removeDirectories") {
    const directories = activeAdditionalWorkingDirectories(deps);
    const removed = update.dirs.map((directory) => resolveWorkingDirectory(directory, ctx.cwd));
    for (const directory of removed) directories.delete(directory);
    await persistAdditionalDirectoryUpdate(removed, update.destination ?? "session", ctx.cwd, true);
    return;
  }
  if (update.type === "addRules") {
    if (update.destination === "session") {
      const sessionAllowed = activeSessionAllowSet(deps);
      for (const rule of update.rules) {
        if (rule.ruleBehavior !== "allow") continue;
        sessionAllowed.add(serializeRuleValue(rule.ruleValue));
      }
      return;
    }
    const next = mergeRules(ctx.rules, update.rules);
    if (next.length > ctx.rules.length) {
      await saveRules(next, ctx.cwd);
    }
    return;
  }
  if (update.type === "removeRules") {
    if (update.source === "session") {
      const sessionAllowed = activeSessionAllowSet(deps);
      for (const rule of update.rules) {
        if (rule.ruleBehavior !== "allow") continue;
        sessionAllowed.delete(serializeRuleValue(rule.ruleValue));
      }
      return;
    }
    // Only the editable settings files can have rules removed here. Policy,
    // flag, CLI-arg, command, and toolsNarrowing sources are immutable at
    // this layer, restricting persistence to
    // localSettings/userSettings/projectSettings.
    if (
      update.source !== "userSettings" &&
      update.source !== "projectSettings" &&
      update.source !== "localSettings"
    ) {
      return;
    }
    const next = removeRulesFromCollection(ctx.rules, update.source, update.rules);
    if (next.length < ctx.rules.length) {
      await saveRules(next, ctx.cwd);
    }
  }
}

function mapMode(
  raw: "default" | "accept-edits" | "plan" | "yolo" | "dontAsk",
): PermissionMode | null {
  if (raw === "yolo" || raw === "accept-edits" || raw === "plan" || raw === "default") return raw;
  return null;
}

function mergeRules(existing: PermissionRule[], added: PermissionRule[]): PermissionRule[] {
  const out = [...existing];
  for (const rule of added) {
    const dup = out.some(
      (r) =>
        r.source === rule.source &&
        r.ruleBehavior === rule.ruleBehavior &&
        r.ruleValue.toolName === rule.ruleValue.toolName &&
        (r.ruleValue.ruleContent ?? "") === (rule.ruleValue.ruleContent ?? ""),
    );
    if (!dup) out.push(rule);
  }
  return out;
}

// Mirrors mergeRules' identity (source + behavior + toolName + ruleContent)
// so a rule added and removed through this same normalization always
// round-trips. Only rules matching `source` are eligible for removal; other
// sources' rules pass through untouched.
function removeRulesFromCollection(
  existing: PermissionRule[],
  source: PermissionRule["source"],
  toRemove: PermissionRule[],
): PermissionRule[] {
  return existing.filter((r) => {
    if (r.source !== source) return true;
    return !toRemove.some(
      (rule) =>
        rule.ruleBehavior === r.ruleBehavior &&
        rule.ruleValue.toolName === r.ruleValue.toolName &&
        (rule.ruleValue.ruleContent ?? "") === (r.ruleValue.ruleContent ?? ""),
    );
  });
}
