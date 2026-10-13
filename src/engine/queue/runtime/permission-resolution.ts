import { realpathSync } from "node:fs";
import { type AgentContext, currentSpawnedAgentScope } from "@/engine/agents/agent-context.ts";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import { permissionAbortSignal } from "@/engine/tools/permission-abort-context.ts";
import type { PermissionDecision } from "@/engine/tools/pipeline.ts";
import { preToolUseHookPermissionSignal } from "@/engine/tools/pretooluse-hook-permission-context.ts";
import * as registry from "@/engine/tools/registry.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import {
  ask as askPermission,
  directoryEditGrant,
  notifyPermissionContextChanged,
  PermissionResults,
} from "@/kernel/channels/permission.ts";
import { fireDirectoryAddedHooks, firePermissionRequestHooks } from "@/kernel/hooks/handler.ts";
import { isMcpAuthToolName } from "@/kernel/mcp/auth/dynamic-tools.ts";
import {
  bashSegmentRule,
  parseRuleValueText,
  permissionInputForCall,
  permissionKeyForCall,
  permissionTargetFieldFromInput,
  RuleStore,
} from "@/kernel/permissions/index.ts";
import { pathRuleRoots } from "@/kernel/permissions/path-rules.ts";
import {
  loadRules,
  persistAdditionalDirectoryUpdate,
  saveRules,
} from "@/kernel/permissions/persist.ts";
import { isSensitiveWriteApprovable } from "@/kernel/permissions/sensitive-paths.ts";
import {
  type PermissionBehavior,
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
import {
  type CompoundBashProbes,
  compoundBashDecision,
  uncoveredCompoundSegments,
} from "./permission-bash-compounds.ts";
import {
  bashBlockedCdDirectories,
  bashBlockedReadPaths,
  bashDangerousRmCriticalPathDecision,
  bashDangerousRmRootVarDecision,
  bashPathOperands,
  bashWriteGrantDirectories,
  bashWritePathDecision,
  bashWritePaths,
  bashWritesCovered,
  isDirectoryChange,
} from "./permission-bash-paths.ts";
import {
  activeAdditionalWorkingDirectories,
  bashCommandFromInput,
  editFilePathFromInput,
  ensureConfiguredWorkingDirectories,
  enterWorktreeExternalPath,
  filePathRepresentations,
  isAcceptEditsBashInWorkingDirectories,
  isAutoMemoryEdit,
  isReadOnlyToolCheck,
  isWorkspaceEdit,
  isWorkspaceRead,
  outsideEditDirectory,
  pathWithinWorkspace,
  readDirectoryGrant,
  readFilePathFromInput,
  workflowNameFromInput,
} from "./permission-workspace.ts";
import {
  agentRejectionText,
  feedbackRejectionText,
  USER_REJECTED_TOOL_RESULT,
} from "./rejection-text.ts";
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
  "Workflow",
]);

/** A lasting approval of a compound command saves at most this many rules. */
const MAX_COMPOUND_RULES = 5;

export interface PermissionResolutionDeps {
  agentDeps: AgentDeps;
  injections: InjectionQueue;
  sessionAllowedToolPatterns: Set<string>;
}

/**
 * The ambient facts a call's permission depends on, read once where the call runs so
 * a later re-check answers for the same call from wherever it is triggered.
 */
interface PermissionCallScope {
  agent: AgentContext | undefined;
  hookPermission: ReturnType<typeof preToolUseHookPermissionSignal>;
}

/** Everything a permission prompt shows and applies when no rule settles the call. */
interface PermissionPrompt {
  kind: "prompt";
  argsPreview: string;
  rule: string | null;
  rules: string[];
  suggestions: PermissionUpdate[];
  /** Outside directories the offered grant opens for reading. */
  readDirectories: string[];
  /** Directories the offered grant opens for a command's file writes. */
  writeDirectories: string[];
  /** The outside directory a session-wide edit approval opens, when the call edits there. */
  editDirectory: string | null;
  /** Why the call needs the user, when no rule allowing the command is the cause. */
  reason: string | null;
  cwd: string;
  requiresUserInteraction: boolean;
  hasRuleAsk: boolean;
  /** Only the user can answer: an ask rule or hook, or a tool that owns its dialog. */
  userMustAnswer: boolean;
}

type PermissionEvaluation = { kind: "decided"; decision: PermissionDecision } | PermissionPrompt;

// Read live from the broker on every decision — a mode change (shift+tab to
// yolo/plan mid-turn, or a remote client) must apply to the very next tool
// call, never wait for the turn to end. A live yolo/accept-edits beats an
// agent-definition mode pinned at spawn; in every other live mode the pinned
// override governs that agent's run.
function currentPermissionMode(
  deps: PermissionResolutionDeps,
  agent: AgentContext | undefined,
): PermissionMode {
  const live = deps.agentDeps.broker.read().permissionMode;
  if (live === "yolo" || live === "accept-edits") return live;
  return agent?.permissionModeOverride ?? live;
}

function decided(decision: PermissionDecision): PermissionEvaluation {
  return { kind: "decided", decision };
}

/** Stated above the question when a command asks only because no rule allows it. */
const NO_RULE_REASON = "This command requires approval";

/**
 * The rules a lasting approval of a Bash command saves: for a compound, one per
 * segment nothing allows yet, so the same compound runs next time; otherwise the
 * command's own rule. A file write the offered directory grant takes needs no rule.
 */
function bashRulesToOffer(
  command: string,
  rule: string,
  probes: CompoundBashProbes,
  takenByGrant: (segment: string) => boolean,
): string[] {
  const needsRule = (segment: string) => !takenByGrant(segment);
  const uncovered = uncoveredCompoundSegments(command, probes);
  if (uncovered === null) return needsRule(command) ? [rule] : [];
  const rules = uncovered.filter(needsRule).map((segment) => bashSegmentRule(segment));
  return [...new Set(rules)].slice(0, MAX_COMPOUND_RULES);
}

/**
 * Decides a call from rules, grants, mode and hooks alone. A call none of them settles
 * comes back as the prompt the user has to answer.
 */
async function evaluatePermission(
  deps: PermissionResolutionDeps,
  call: ToolCall,
  scope: PermissionCallScope,
): Promise<PermissionEvaluation> {
  // Dynamic MCP authenticate/complete_authentication pseudo-tools carry a
  // per-server wire name (mcp__<server>__authenticate), so they can't live in
  // the static PERMISSION_FREE_TOOLS set — matched by wire-name shape
  // instead (MCP-003).
  const handler = registry.get(call.name);
  const permissionFree =
    PERMISSION_FREE_TOOLS.has(call.name) ||
    isMcpAuthToolName(call.name) ||
    handler?.isPermissionFree?.(call.input) === true;
  await ensureConfiguredWorkingDirectories(deps);
  const argsPreview = previewArgs(call.input);
  const cwd = deps.agentDeps.session.cwd;
  const additionalWorkingDirectories = activeAdditionalWorkingDirectories(deps);
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
  const store = new RuleStore(pathRuleRoots(cwd));
  store.addAll(rules);
  // Session grants are one set for the whole session: a grant made inside an agent
  // covers the main session and every other agent at once. Explicit deny/ask rules
  // are matched alongside and always take precedence over them.
  for (const pattern of deps.sessionAllowedToolPatterns) {
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
  const command = call.name === "Bash" ? bashCommandFromInput(call.input) : null;
  // The file rules hold for Bash too: a path a Read or Edit rule covers is covered
  // whether the Read/Edit tools or a shell command touch it.
  const pathRule = (toolName: "Read" | "Edit", behavior: PermissionBehavior) => {
    const aliases = registry.aliasNamesFor(toolName);
    return (path: string): boolean =>
      filePathRepresentations(path, cwd, true).some(
        (representation) => store.match(toolName, representation, aliases) === behavior,
      );
  };
  const editAllowed = pathRule("Edit", "allow");
  const operands = command === null ? null : bashPathOperands(command, cwd);
  const bashPathDenied =
    operands !== null &&
    (operands.reads.some(pathRule("Read", "deny")) ||
      operands.writes.some(pathRule("Edit", "deny")));
  if (matched === "deny" || fileRuleDenied || fieldDenyRule !== null || bashPathDenied) {
    return decided("deny");
  }
  const hasRuleAsk = matched === "ask" || fileRuleAsked || fieldAskRule !== null;
  if (!hasRuleAsk && isAutoMemoryEdit(call.name, call.input, cwd)) return decided("allow");
  if (permissionFree && !hasRuleAsk && !requiresUserInteraction) return decided("allow");
  // PERM-HOOK-ALLOW-BYPASS-001: a PreToolUse hook's explicit
  // hookSpecificOutput.permissionDecision:"allow" re-checks only the explicit
  // deny/ask rules just evaluated above and, finding none, resolves straight to allow,
  // bypassing the interactive/headless/background-agent prompt path entirely
  // (askPermission / headlessAutoDeny / backgroundAgentAutoDeny below). A
  // requiresUserInteraction tool (e.g. AskUserQuestion) still owns its own
  // dialog and is excluded here, matching every other bypass above.
  const hookPermission = scope.hookPermission;
  if (
    canonicalName === "EnterWorktree" &&
    !enterWorktreeNeedsAsk &&
    !hasRuleAsk &&
    hookPermission !== "ask" &&
    !requiresUserInteraction
  ) {
    return decided("allow");
  }
  if (hookPermission === "allow" && !hasRuleAsk && !requiresUserInteraction) {
    return decided("allow");
  }
  let compound: ReturnType<typeof compoundBashDecision> = null;
  // A single-argument `cd` segment needs no rule of its own: the cd check below asks
  // for any destination outside the workspace before a compound allow applies.
  const compoundProbes: CompoundBashProbes = {
    matchSub: (sub) => store.match(canonicalName, sub, aliasNames),
    subSessionAllowed: () => false,
    subAutoAllowed: (sub) =>
      isReadOnlyBashCommand(sub) ||
      (isDirectoryChange(sub) && sub.trim().split(/\s+/).length <= 2) ||
      bashWritesCovered(sub, editAllowed),
  };
  // Ordering: argv-level path safety runs after explicit Bash
  // deny/ask rules but before an allow rule, session grant, or permissive mode.
  const bashPathDecision =
    command === null ? null : bashWritePathDecision(command, cwd, additionalWorkingDirectories);
  const readAllowed = pathRule("Read", "allow");
  const blockedReads =
    command === null
      ? []
      : bashBlockedReadPaths(command, cwd, additionalWorkingDirectories, readAllowed);
  const blockedCd =
    command === null
      ? []
      : bashBlockedCdDirectories(command, cwd, additionalWorkingDirectories, readAllowed);
  const bashCdDecision = blockedCd === null || blockedCd.length > 0 ? "ask" : null;
  const bashDangerousRmDecision = command === null ? null : bashDangerousRmRootVarDecision(command);
  const bashDangerousRmPathDecision =
    command === null
      ? null
      : bashDangerousRmCriticalPathDecision(command, cwd, additionalWorkingDirectories);
  const mode = currentPermissionMode(deps, scope.agent);
  if (matched !== "ask" && command !== null) {
    compound = compoundBashDecision(command, compoundProbes);
    if (compound === "deny") return decided("deny");
    if (
      compound === "allow" &&
      hookPermission !== "ask" &&
      bashPathDecision === null &&
      blockedReads.length === 0 &&
      bashCdDecision === null &&
      bashDangerousRmDecision === null &&
      bashDangerousRmPathDecision === null
    ) {
      return decided("allow");
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
        blockedReads.length > 0 ||
        bashCdDecision === "ask" ||
        compound === "ask" ||
        !isSensitiveWriteApprovable(call.name, call.input, cwd, (path, base) =>
          filePathRepresentations(path, base ?? cwd, true),
        )));
  if (!mustAsk) {
    if (isWorkspaceRead(call.name, call.input, cwd, realpathSync, additionalWorkingDirectories))
      return decided("allow");
    if (call.name === "Bash" && isReadOnlyToolCheck(call.name, call.input)) return decided("allow");
    if (matched === "allow" && !requiresUserInteraction) return decided("allow");
    if (command !== null && bashWritesCovered(command, editAllowed)) return decided("allow");
    if (mode === "yolo" && !requiresUserInteraction) return decided("allow");
    if (mode === "accept-edits") {
      if (isWorkspaceEdit(call.name, call.input, cwd, additionalWorkingDirectories)) {
        return decided("allow");
      }
      if (
        command !== null &&
        isAcceptEditsBashInWorkingDirectories(command, cwd, additionalWorkingDirectories)
      )
        return decided("allow");
    }
  }
  const readGrant = readDirectoryGrant(
    canonicalName === "Read"
      ? filePath === null
        ? []
        : [filePath]
      : [...blockedReads, ...(blockedCd ?? [])],
    cwd,
    additionalWorkingDirectories,
    // A command's grant lasts for the project; the Read tool's lasts for the session.
    command === null ? "session" : "localSettings",
  );
  // The path checks run ahead of every command rule, so a call one of them holds is
  // settled by opening a directory, never by a rule that would ask again next time.
  const pathHeld =
    bashPathDecision === "ask" ||
    blockedReads.length > 0 ||
    bashCdDecision === "ask" ||
    bashDangerousRmDecision === "ask" ||
    bashDangerousRmPathDecision === "ask";
  const writeDirectories =
    command === null || blockedReads.length > 0 || bashCdDecision === "ask"
      ? null
      : bashWriteGrantDirectories(command, cwd, editAllowed);
  const writesGranted = writeDirectories !== null && writeDirectories.length > 0;
  // A read held for an outside directory is settled by opening that directory.
  const rulesToOffer =
    command === null
      ? readGrant.updates.length > 0
        ? []
        : [permissionPattern]
      : pathHeld
        ? []
        : bashRulesToOffer(command, permissionPattern, compoundProbes, (segment) =>
            writesGranted ? bashWritePaths(segment) !== null : false,
          );
  const writeGrant = writesGranted
    ? directoryEditGrant(
        writeDirectories,
        writeDirectories.filter(
          (directory) =>
            !pathWithinWorkspace(directory, cwd, realpathSync, additionalWorkingDirectories),
        ),
        "localSettings",
      )
    : [];
  const grants = [...readGrant.updates, ...writeGrant];
  const userMustAnswer =
    hasRuleAsk || compound === "rule-ask" || hookPermission === "ask" || requiresUserInteraction;
  // A command's rules ride along with the directories it opens, as one approval.
  const suggestions =
    command !== null && grants.length > 0 && rulesToOffer.length > 0
      ? [...grants, ...PermissionResults.allowAlwaysAll(rulesToOffer).updates]
      : grants;
  return {
    kind: "prompt",
    argsPreview,
    rule: rulesToOffer.length === 1 && grants.length === 0 ? (rulesToOffer[0] ?? null) : null,
    rules: rulesToOffer,
    suggestions,
    readDirectories: readGrant.directories,
    writeDirectories: writesGranted ? writeDirectories : [],
    editDirectory:
      command === null
        ? outsideEditDirectory(call.name, call.input, cwd, additionalWorkingDirectories)
        : null,
    reason:
      command !== null && !userMustAnswer && !pathHeld && compound !== "ask" && grants.length === 0
        ? NO_RULE_REASON
        : null,
    cwd,
    requiresUserInteraction,
    hasRuleAsk,
    userMustAnswer,
  };
}

export async function resolvePermission(
  deps: PermissionResolutionDeps,
  call: ToolCall,
  signal: AbortSignal | undefined = permissionAbortSignal(),
): Promise<PermissionDecision> {
  const scope: PermissionCallScope = {
    agent: currentSpawnedAgentScope(),
    hookPermission: preToolUseHookPermissionSignal(),
  };
  const evaluation = await evaluatePermission(deps, call, scope);
  if (evaluation.kind === "decided") return evaluation.decision;
  const { argsPreview, cwd, suggestions, readDirectories } = evaluation;
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
  const agentContext = scope.agent;
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
  if (!evaluation.hasRuleAsk && evaluation.requiresUserInteraction) return "allow";
  // A waiting prompt answers itself once another answer's rules, directories or
  // mode already allow this call.
  const recheck = evaluation.userMustAnswer
    ? undefined
    : async () => {
        const again = await evaluatePermission(deps, call, scope);
        return again.kind === "decided" && again.decision === "allow";
      };
  const result = await askPermission(
    {
      toolName: call.name,
      argsPreview,
      rule: evaluation.rule,
      ...(evaluation.rule === null && evaluation.rules.length > 0
        ? { rules: evaluation.rules }
        : {}),
      input: call.input,
      readOnly: isReadOnlyToolCheck(call.name, call.input),
      editDirectory: evaluation.editDirectory,
      ...(suggestions.length > 0 ? { suggestions } : {}),
      ...(readDirectories.length > 0 ? { readDirectories } : {}),
      ...(evaluation.writeDirectories.length > 0
        ? { writeDirectories: evaluation.writeDirectories }
        : {}),
      ...(evaluation.reason === null ? {} : { reason: evaluation.reason }),
      cwd,
      ...(recheck ? { recheck } : {}),
      ...(agentContext
        ? { source: { name: agentContext.subagentName, depth: agentContext.depth } }
        : {}),
    },
    signal,
  );
  const feedback = result.feedback?.trim();
  if (result.decision === "deny") {
    // A prompt the turn's own cancellation closed was not answered by the user.
    if (signal?.aborted) return "deny";
    const directions = feedback || undefined;
    return agentContext ? agentRejection(directions) : mainThreadRejection(directions);
  }
  for (const update of result.updates) {
    await applyUpdate(deps, update, { cwd, agent: scope.agent });
  }
  if (result.updates.length > 0) notifyPermissionContextChanged();
  // Feedback typed on an approval arrives after the tool result, at the next
  // continuation boundary — same queue the plan feedback uses.
  if (feedback && feedback.length > 0) {
    deps.injections.push(`[user-feedback-on-tool-approval]\n${feedback}`);
  }
  return result.decision;
}

/**
 * What the user's rejection at a prompt returns on the main thread. Their directions
 * ride the denial so the model adjusts at once; without any, the turn stops and waits.
 */
function mainThreadRejection(directions: string | undefined): PermissionDecision {
  if (directions) return { kind: "deny", message: feedbackRejectionText(directions) };
  return { kind: "deny", message: USER_REJECTED_TOOL_RESULT, stopsTurn: true };
}

/** What the user's rejection returns to an agent, which looks for another way on its own. */
function agentRejection(directions: string | undefined): PermissionDecision {
  return { kind: "deny", message: agentRejectionText(directions) };
}

interface ApplyContext {
  cwd: string;
  agent: AgentContext | undefined;
}

async function applyUpdate(
  deps: PermissionResolutionDeps,
  update: PermissionUpdate,
  ctx: ApplyContext,
): Promise<void> {
  if (update.type === "setMode") {
    const mode = update.mode;
    if (mode === "accept-edits" && currentPermissionMode(deps, ctx.agent) !== "default") return;
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
      for (const rule of update.rules) {
        if (rule.ruleBehavior !== "allow") continue;
        deps.sessionAllowedToolPatterns.add(serializeRuleValue(rule.ruleValue));
      }
      return;
    }
    // Read at write time: another prompt may have saved rules while this one waited.
    const current = await loadRules(ctx.cwd);
    const next = mergeRules(current, update.rules);
    if (next.length > current.length) {
      await saveRules(next, ctx.cwd);
    }
    return;
  }
  if (update.type === "removeRules") {
    if (update.source === "session") {
      for (const rule of update.rules) {
        if (rule.ruleBehavior !== "allow") continue;
        deps.sessionAllowedToolPatterns.delete(serializeRuleValue(rule.ruleValue));
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
    const current = await loadRules(ctx.cwd);
    const next = removeRulesFromCollection(current, update.source, update.rules);
    if (next.length < current.length) {
      await saveRules(next, ctx.cwd);
    }
  }
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
