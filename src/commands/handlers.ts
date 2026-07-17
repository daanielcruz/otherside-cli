import { readFile } from "node:fs/promises";
import type { SlashCommand, SlashKind } from "@/commands/catalog.ts";
import { handleCd } from "@/commands/handlers/cd.ts";
import { handleCompact } from "@/commands/handlers/compact.ts";
import { handleContext } from "@/commands/handlers/context.ts";
import { handleCopy } from "@/commands/handlers/copy.ts";
import { handleDesign } from "@/commands/handlers/design.ts";
import { handleEffort } from "@/commands/handlers/effort.ts";
import { handleFork } from "@/commands/handlers/fork.ts";
import { handleGoal } from "@/commands/handlers/goal.ts";
import { handleMarketplace, handlePlugins } from "@/commands/handlers/plugins.ts";
import { handleReload } from "@/commands/handlers/reload.ts";
import type { SlashContext, SlashHandler, SlashResult } from "@/commands/types.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { ensureRuntimeModel, findModel } from "@/engine/model/catalog.ts";
import { activePlanFilePath } from "@/engine/tools/plan-gate.ts";
import { effectiveOrchestrationMode, updateConfig } from "@/kernel/config/config.ts";
import {
  ORCHESTRATION_MODE_VALUES,
  type OrchestrationMode,
  orchestrationModeLabel,
} from "@/kernel/config/orchestration-mode.ts";
import { deleteFor, type ProviderSlug } from "@/kernel/storage/credentials.ts";
import {
  isAutoMemoryEnabled,
  setAutoMemorySessionEnabled,
} from "@/kernel/storage/memory/session-toggle.ts";
import { setPendingPluginCommandResult } from "@/ui/panels/plugins/command-result.ts";

/** `/plugin` subcommands that should open the Plugins panel with command feedback. */
const PLUGIN_MUTATING_SUBCOMMANDS = new Set([
  "install",
  "update",
  "enable",
  "disable",
  "uninstall",
  "remove",
]);

async function handleExit(
  _cmd: SlashCommand,
  _args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  // If still inside an EnterWorktree session, prompt keep/remove (tmux
  // killed on remove, left running on keep) before tearing down the TUI.
  try {
    const { resolveWorktreeOnSessionExit } = await import(
      "@/engine/tools/builtins/worktree-exit.ts"
    );
    const result = await resolveWorktreeOnSessionExit(ctx.session);
    if (result.action === "cancel") return { kind: "instant" };
  } catch {
    // Best-effort — never block process exit on worktree cleanup failure.
  }
  ctx.exit();
  return { kind: "instant" };
}

function handleClear(cmd: SlashCommand, _args: string, ctx: SlashContext): SlashResult {
  ctx.clearTranscript();
  return { kind: "instant", command: cmd, feedback: "(no content)" };
}

function currentPlanFeedback(filePath: string, content: string): string {
  const plan = content.trimEnd();
  return [
    "Current Plan",
    filePath,
    "",
    plan.length > 0 ? plan : "No plan has been written yet.",
    "",
    '"/plan open" to edit this plan',
  ].join("\n");
}

// Enter-only: exiting plan is the leader's own call (ExitPlanMode, or the
// interactive escalation), never a silent side effect of re-running /plan.
// When already active, /plan remains entirely local and renders the session's
// current plan file instead of starting a model turn.
async function handlePlan(
  cmd: SlashCommand,
  _args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const state = ctx.broker.read();
  if (state.permissionMode === "plan") {
    const filePath = activePlanFilePath(ctx.session.id);
    const content = await readFile(filePath, "utf8").catch(() => "");
    return {
      kind: "toggle",
      command: cmd,
      feedback: currentPlanFeedback(filePath, content),
    };
  }
  ctx.broker.dispatch({ kind: "set_permission_mode", mode: "plan" });
  return { kind: "toggle", command: cmd, feedback: "Entered plan mode" };
}

function handleFast(cmd: SlashCommand, _args: string, ctx: SlashContext): SlashResult {
  const active = getProviderConfig(ctx.broker.read().provider);
  if (!active?.featureFlags?.fastMode) {
    return {
      kind: "toggle",
      command: cmd,
      feedback: `Fast mode is not available for ${active?.provider.label ?? ctx.broker.read().provider}`,
    };
  }
  const state = ctx.broker.read();
  const next = !state.fastMode;
  return {
    kind: "toggle",
    command: cmd,
    feedback: next ? "Enabled fast mode" : "Disabled fast mode",
    pendingChange: { kind: "set_fast_mode", enabled: next },
  };
}

function toggleValue(args: string, current: boolean): boolean | null {
  const normalized = args.trim().toLowerCase();
  if (normalized.length === 0) return !current;
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  return null;
}

function handleParallel(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const current = ctx.config?.parallelTasks ?? false;
  const enabled = toggleValue(args, current);
  if (enabled === null) {
    return { kind: "toggle", command: cmd, feedback: "Usage: /parallel [on|off]" };
  }
  void updateConfig((config) => {
    config.parallelTasks = enabled;
  });
  return {
    kind: "toggle",
    command: cmd,
    feedback: `Parallel tasks ${enabled ? "enabled" : "disabled"}`,
  };
}

function handleMultiprovider(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const current = effectiveOrchestrationMode(ctx.config);
  const raw = args.trim();
  let selected: OrchestrationMode;
  if (raw.length === 0) {
    const index = ORCHESTRATION_MODE_VALUES.indexOf(current);
    selected = ORCHESTRATION_MODE_VALUES[(index + 1) % ORCHESTRATION_MODE_VALUES.length] ?? current;
  } else if ((ORCHESTRATION_MODE_VALUES as readonly string[]).includes(raw)) {
    selected = raw as OrchestrationMode;
  } else {
    return {
      kind: "toggle",
      command: cmd,
      feedback: "Usage: /multiprovider [disabled|default|feudalism]",
    };
  }
  void updateConfig((config) => {
    config.orchestrationMode = selected;
  });
  return {
    kind: "toggle",
    command: cmd,
    feedback: `Multiprovider set to ${orchestrationModeLabel(selected)}`,
  };
}

function handleToggleMemory(cmd: SlashCommand, _args: string, _ctx: SlashContext): SlashResult {
  const next = !isAutoMemoryEnabled();
  setAutoMemorySessionEnabled(next);
  return {
    kind: "toggle",
    command: cmd,
    feedback: next
      ? "Auto memory enabled for this session"
      : "Auto memory disabled for this session",
  };
}

function handleConfig(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const normalized = args.trim().toLowerCase();
  if (normalized === "details" || normalized === "detail") {
    ctx.openOverlay(cmd.name, "details");
    return { kind: "panel", command: cmd };
  }
  if (normalized === "config" || normalized === "settings") {
    ctx.openOverlay(cmd.name, "config");
    return { kind: "panel", command: cmd };
  }
  ctx.openOverlay(cmd.name);
  return { kind: "panel", command: cmd };
}

export function setModelFeedback(display: string): string {
  return `Set model to ${display}`;
}

export function keptModelFeedback(display: string): string {
  return `Kept model as ${display}`;
}

function handleModel(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const requested = args.trim();
  if (requested.length === 0) {
    ctx.openOverlay(cmd.name);
    return { kind: "panel", command: cmd };
  }
  const state = ctx.broker.read();
  const resolved = findModel(requested, state.provider);
  const entry = resolved ?? ensureRuntimeModel(requested, state.provider);
  const provider = entry.provider;
  const providerLabel = getProviderConfig(provider)?.provider.label ?? provider;
  const display = resolved
    ? entry.displayName
    : `${entry.id} (custom — passed through to ${providerLabel})`;
  if (entry.id === state.model && provider === state.provider) {
    return { kind: "toggle", command: cmd, feedback: keptModelFeedback(entry.displayName) };
  }
  return {
    kind: "toggle",
    command: cmd,
    feedback: setModelFeedback(display),
    pendingChange: { kind: "set_model", provider, model: entry.id, persistDefault: true },
  };
}

function handleBtw(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const question = args.trim();
  if (question.length === 0) {
    return { kind: "instant", command: cmd, feedback: "Usage: /btw <question>" };
  }
  ctx.enterBtwMode?.(question);
  return { kind: "instant", command: cmd };
}

function handleLogout(cmd: SlashCommand, _args: string, ctx: SlashContext): SlashResult {
  const provider = ctx.broker.read().provider as ProviderSlug;
  void deleteFor(provider).finally(() => {
    setTimeout(() => ctx.exit(), 200);
  });
  return {
    kind: "auth",
    command: cmd,
    feedback: `Successfully logged out from your ${getProviderConfig(provider)?.provider.label ?? provider} account.`,
  };
}

function defaultInstant(cmd: SlashCommand): SlashResult {
  return { kind: "instant", command: cmd };
}

function defaultToggle(cmd: SlashCommand): SlashResult {
  return { kind: "toggle", command: cmd, feedback: `${cmd.name} toggled` };
}

function defaultPanel(cmd: SlashCommand, _args: string, ctx: SlashContext): SlashResult {
  ctx.openOverlay(cmd.name);
  return { kind: "panel", command: cmd };
}

function defaultAnchor(cmd: SlashCommand): SlashResult {
  return { kind: "anchor", command: cmd, feedback: `${cmd.name} anchor — Phase 14` };
}

function defaultSkill(cmd: SlashCommand): SlashResult {
  return { kind: "skill", command: cmd, feedback: `${cmd.name} — Phase 11` };
}

function defaultWorkflow(cmd: SlashCommand): SlashResult {
  return { kind: "workflow", command: cmd };
}

function defaultAuth(cmd: SlashCommand, _args: string, ctx: SlashContext): SlashResult {
  ctx.openOverlay(cmd.name);
  return { kind: "auth", command: cmd };
}

function defaultExternal(cmd: SlashCommand): SlashResult {
  return { kind: "external", command: cmd, feedback: `${cmd.name} — external` };
}

export const HANDLERS: Record<string, SlashHandler> = {
  exit: handleExit,
  quit: handleExit,
  clear: handleClear,
  plan: handlePlan,
  fast: handleFast,
  parallel: handleParallel,
  multiprovider: handleMultiprovider,
  "toggle-memory": handleToggleMemory,
  copy: handleCopy,
  effort: handleEffort,
  config: handleConfig,
  context: handleContext,
  goal: handleGoal,
  compact: handleCompact,
  model: handleModel,
  reload: handleReload,
  cd: handleCd,
  logout: handleLogout,
  btw: handleBtw,
  sidequest: handleBtw,
  fork: handleFork,
  design: handleDesign,
  plugins: async (cmd, args, ctx) => {
    if (args.trim() === "") {
      ctx.openOverlay("plugins");
      return { kind: "panel", command: cmd };
    }
    const result = await handlePlugins(args);
    const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    // Mutating plugin ops open the panel with the result rendered inside it
    // (command feedback lives in the Plugins overlay).
    // Non-mutating list / marketplace list keep printing to the transcript.
    if (PLUGIN_MUTATING_SUBCOMMANDS.has(sub) && result.feedback) {
      setPendingPluginCommandResult(result.feedback);
      ctx.openOverlay?.("plugins");
      return { kind: "panel", command: cmd };
    }
    return { ...result, command: cmd };
  },
  marketplace: async (_cmd, args) => handleMarketplace(args),
};

export const DEFAULT_BY_KIND: Record<SlashKind, SlashHandler> = {
  instant: (cmd) => defaultInstant(cmd),
  toggle: (cmd) => defaultToggle(cmd),
  panel: defaultPanel,
  anchor: (cmd) => defaultAnchor(cmd),
  skill: (cmd) => defaultSkill(cmd),
  workflow: (cmd) => defaultWorkflow(cmd),
  auth: defaultAuth,
  external: (cmd) => defaultExternal(cmd),
};
