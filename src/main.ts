// Must precede every other import: werift's dependency chain (tsyringe)
// resolves Reflect metadata during compiled-bundle module init.
import "reflect-metadata";
import "@/devtools/bootstrap.ts";
import "@/engine/background/tasks/background.ts";
import "@/engine/background/workflows/runtime/store/store.ts";
import "@/engine/providers/usage-quota-snapshot.ts";
import "@/engine/queue/emit.ts";
import "@/engine/session/usage/limits.ts";
import { emitPushEvent } from "@/backend/index.ts";
import { resolveStartupBroker } from "@/boot/startup-broker.ts";
import { loadStartupConfig } from "@/boot/startup-config.ts";
import { resolveStartupResume } from "@/boot/startup-resume.ts";
import { buildResumedSession } from "@/boot/startup-session.ts";
import { applyStartupWorktree } from "@/boot/startup-worktree.ts";
import { maybeReexecWithAllocLever } from "@/devtools/memory/allocator.ts";
import { installGcCadence } from "@/devtools/memory/gc-cadence.ts";
import { installHeapDumpTrigger } from "@/devtools/memory/heap-dump.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import * as tools from "@/engine/tools/registry.ts";
import { bootstrapLlmApiRegistry } from "@/engine/translator/bootstrap.ts";
import { registerBuiltinClassifiers } from "@/engine/transport/errors.ts";
import { registerPermissionPushEmitter } from "@/kernel/channels/permission.ts";
import { claimInitialSetupHook } from "@/kernel/config/config.ts";
import { fireConfiguredHooks, fireSetupHooksInBackground } from "@/kernel/hooks/handler.ts";
import { refreshMcpTools, setMcpToolRegistry } from "@/kernel/mcp/index.ts";
import { installEpipeGuard } from "@/kernel/std/proc/epipe.ts";
import { parseArgs } from "@/modes/args.ts";
import { runInteractiveEntrypoint } from "@/modes/interactive/index.ts";
import { maybeRunTerminalMode } from "@/modes/one-shot.ts";
import { runPrintEntrypoint } from "@/modes/print/entrypoint.ts";
import {
  ITERM2_COMMANDS,
  OSC,
  osc,
  PROGRESS_STATES,
  setTerminalProgressSequenceBuilder,
  type TerminalProgressState,
  wrapForSessionManager,
} from "@/terminal-runtime";

const TERMINAL_PROGRESS_CODE: Record<TerminalProgressState, number> = {
  indeterminate: PROGRESS_STATES.INDETERMINATE,
  completed: PROGRESS_STATES.CLEAR,
  error: PROGRESS_STATES.ERROR,
};

setTerminalProgressSequenceBuilder((state) =>
  wrapForSessionManager(
    osc(OSC.ITERM2_COMMANDS, ITERM2_COMMANDS.PROGRESS_STATES, TERMINAL_PROGRESS_CODE[state]),
  ),
);

maybeReexecWithAllocLever();

if (typeof process.stdout.setMaxListeners === "function") process.stdout.setMaxListeners(0);
if (typeof process.stderr.setMaxListeners === "function") process.stderr.setMaxListeners(0);
if (typeof process.stdin.setMaxListeners === "function") process.stdin.setMaxListeners(0);

installEpipeGuard();

process.env.OTHERSIDE_EXECPATH = process.execPath;

installHeapDumpTrigger();
installGcCadence();
registerPermissionPushEmitter(emitPushEvent);

async function main(): Promise<void> {
  bootstrapLlmApiRegistry();
  registerBuiltinClassifiers();
  const mode = parseArgs(Bun.argv);
  if (mode.kind === "print") {
    if (mode.prompt.trim().length === 0 && !process.stdin.isTTY) {
      mode.prompt = (await Bun.stdin.text()).trim();
    }
    if (/^\/cd(?:\s|$)/.test(mode.prompt.trim())) {
      process.stdout.write("/cd isn't available in this environment.\n");
      return;
    }
  }
  const { setRuntimeKind } = await import("@/kernel/std/proc/runtime-mode.ts");
  setRuntimeKind(
    mode.kind === "print" || mode.kind === "interactive" || mode.kind === "piped"
      ? mode.kind
      : null,
  );
  const { setYoloMode } = await import("@/kernel/std/proc/yolo-mode.ts");
  setYoloMode((mode.kind === "interactive" || mode.kind === "print") && mode.yolo);

  if (await maybeRunTerminalMode(mode)) return;
  if (mode.kind !== "interactive" && mode.kind !== "print") return;

  registerAllBuiltins();
  setMcpToolRegistry(tools);

  const shouldFireSetupHook = claimInitialSetupHook();
  const thinkingDisplayOverride =
    mode.thinkingDisplay === null
      ? undefined
      : { showThinkingSummaries: mode.thinkingDisplay === "summarized" };
  const { cfg, allCreds, customCreds, agentFailures } = await loadStartupConfig(
    process.cwd(),
    thinkingDisplayOverride,
  );
  if (shouldFireSetupHook) fireSetupHooksInBackground(cfg, "init");
  // Before any server connects: the handshake tells them they may ask, so the
  // answer has to already be there when the first one does.
  const { serveElicitation } = await import("@/engine/mcp/elicitation.ts");
  const { serveRoots } = await import("@/engine/mcp/roots.ts");
  const { watchServerNotices } = await import("@/engine/mcp/server-notices.ts");
  serveElicitation();
  serveRoots(() => process.cwd());
  watchServerNotices(() => process.cwd());
  const mcpBootLoad = refreshMcpTools(process.cwd())
    .then(async () => {
      const { refreshServerPrompts } = await import("@/engine/mcp/prompts.ts");
      await refreshServerPrompts();
    })
    .catch(() => {});

  const { effectiveResumeId, resumeLoad } = await resolveStartupResume(mode);
  const resumeRecords = resumeLoad.records;
  const resumeTailRecords = resumeLoad.tailRecords;
  const isResume = effectiveResumeId !== null;

  const { broker, initialProvider, initialModel, cliProviderRaw, cliProviderMissingCreds } =
    resolveStartupBroker({
      mode,
      cfg,
      allCreds,
      customCreds,
      resumeRecords,
      isResume,
    });
  const { session, agent } = await buildResumedSession({
    effectiveResumeId,
    resumeRecords,
    resumeRecordsArePartial: resumeLoad.recordsArePartial,
    resumeModelRecords: resumeLoad.modelRecords,
    resumeUsageRecords: resumeLoad.usageRecords,
    chainHead: resumeLoad.chainHead,
    resumeCwd: resumeLoad.cwd,
    resumePreservedImageLedger: resumeLoad.preservedImageLedger,
    isResume,
    broker,
    cfg,
    isPrint: mode.kind === "print",
  });

  await applyStartupWorktree({
    session,
    cfg,
    worktree: mode.worktree,
    tmux: mode.tmux,
    isResume,
    resumeRecords,
  });

  await fireConfiguredHooks(cfg, "sessionStart", {
    kind: "sessionStart",
    ctx: {
      sessionId: session.id,
      cwd: session.cwd,
      source: isResume ? "resume" : "startup",
    },
  });

  if (mode.kind === "print") {
    await mcpBootLoad;
    await runPrintEntrypoint({
      mode,
      agent,
      session,
      broker,
      initialProvider,
      initialModel,
      customCreds,
    });
    return;
  }

  await runInteractiveEntrypoint({
    agent,
    broker,
    session,
    cfg,
    allCreds,
    cliProviderMissingCreds,
    cliProviderRaw,
    resumeTailRecords,
    agentFailures,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
