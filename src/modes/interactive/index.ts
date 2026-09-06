import { OTHERSIDE_VERSION } from "@/boot/version.ts";
import { startCronScheduler } from "@/engine/background/cron/scheduler.ts";
import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import { startSharedOutputPoller } from "@/engine/background/tasks/output-poller.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { drainPendingAsyncRewakeHooks } from "@/engine/queue/runtime/stop-hook-rewake.ts";
import {
  finalizeSession,
  hasSessionTranscript,
  type loadSessionForResume,
  resumeExitText,
  type Session,
} from "@/engine/session/index.ts";
import type { loadConfig } from "@/kernel/config/config.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { installWatchdogCaptureHooks } from "@/kernel/std/stream/debug-capture.ts";
import { PROVIDER_ID_VALUES, type ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { hasCredential, type loadAll as loadAllCredentials } from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { submitMcpFailuresNotice } from "@/store/app-store/right-region-notices.ts";
import { bootSubscribers } from "@/store/subscribers/index.ts";
import {
  ERASE_DISPLAY_TO_END,
  emitTerminalProgress,
  OSC,
  oscWithStringTerminator,
  registerTerminalRecovery,
  startEventLoopMonitor,
} from "@/terminal-runtime";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";

const REGISTRY_HEARTBEAT_MS = 30_000;

/** One blank row above a restored transcript so it is not glued to the shell. */
const RESUMED_BOOT_MARGIN = [""] as const;

/** Fresh banner already clears the shell; only an empty (resumed) prelude needs a gap. */
export function applyBootPreludeMargin(rows: readonly string[]): readonly string[] {
  return rows.length === 0 ? RESUMED_BOOT_MARGIN : rows;
}

/**
 * Boot-time problems the user has to fix in their own files (an agent that would
 * not parse, an MCP server that would not connect) land as system rows in the
 * live transcript — the only startup surface that survives the first repaint.
 */
async function appendStartupNotices(texts: readonly string[]): Promise<void> {
  if (texts.length === 0) return;
  const { transcriptActions } = await import("@/store/transcript/index.ts");
  const { nextTranscriptId } = await import("@/store/turn-tracking/index.ts");
  transcriptActions.update((entries) => [
    ...entries,
    ...texts.map((text) => ({
      id: nextTranscriptId("startup_notice"),
      kind: "system" as const,
      text,
      isError: true,
    })),
  ]);
}

export async function runInteractiveEntrypoint(args: {
  agent: Agent;
  broker: Broker;
  session: Session;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  allCreds: Awaited<ReturnType<typeof loadAllCredentials>>;
  cliProviderMissingCreds: boolean;
  cliProviderRaw: string | null;
  /** Fully-typed tail only — projection input is capped here (not full records). */
  resumeTailRecords: Awaited<ReturnType<typeof loadSessionForResume>>["tailRecords"];
  /** Agent files the corpus load skipped; the counts alone never say so. */
  agentFailures?: readonly string[];
}): Promise<void> {
  const {
    agent,
    broker,
    session,
    cfg,
    allCreds,
    cliProviderMissingCreds,
    cliProviderRaw,
    resumeTailRecords,
    agentFailures,
  } = args;
  startCronScheduler(agent);

  const needsLogin =
    !PROVIDER_ID_VALUES.some((provider) => hasCredential(allCreds, provider)) ||
    cliProviderMissingCreds;
  const isFirstLaunch = cfg.theme === undefined;
  const overlayChain: ("theme" | "login")[] = [];
  if (isFirstLaunch) overlayChain.push("theme");
  if (needsLogin) overlayChain.push("login");
  const initialLoginProvider = cliProviderMissingCreds ? (cliProviderRaw as ProviderId) : undefined;

  if (process.stdout.isTTY) {
    process.stdout.write(oscWithStringTerminator(OSC.SET_TITLE_AND_ICON, "Otherside CLI"));
    registerTerminalRecovery();
    emitTerminalProgress("completed");
  }

  startEventLoopMonitor();
  installWatchdogCaptureHooks();
  startSharedOutputPoller();
  bootSubscribers({ broker });
  const { resumeDesign } = await import("@/design/launcher.ts");
  try {
    await resumeDesign({
      broker,
      session,
      agent,
      cwd: session.cwd,
      version: OTHERSIDE_VERSION,
    });
  } catch (error) {
    process.stderr.write(
      `design relay: resume failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  let inlineController: {
    finished: () => Promise<void>;
    repaint: () => void;
    redraw: () => void;
    close: () => void;
  };
  // Leaving is a teardown, not a kill: it has to reach the session-end hooks, the
  // session file and the resume hint that follow the render loop. Before anything is
  // mounted there is no teardown to run, so until then the only honest answer is to stop.
  let leaveSession = (): void => process.exit(0);
  const { openStringView } = await import(
    "@/terminal-runtime/string-view/host/string-view-host.ts"
  );
  const { buildStringViewRoot } = await import("@/ui/app/string-view-root.ts");
  const { createStringViewSubmit } = await import("@/ui/app/dispatch/string-view-dispatch.ts");
  const turnDispatch = createStringViewSubmit({
    session,
    broker,
    agent,
    runtimeConfig: cfg,
    version: OTHERSIDE_VERSION,
    exit: () => leaveSession(),
  });
  const { setExitHintArmed } = await import("@/store/exit-hint/index.ts");
  const { createWelcomePrelude } = await import("@/ui/chrome/string-view-welcome.ts");
  const { activateStringViewUsage } = await import("@/ui/app/usage/string-view-usage.ts");
  const initialTranscript = sessionRecordsToTranscript(resumeTailRecords);
  // A session that boots with messages on screen is resumed: its title is
  // settled (or deliberately absent) and must not regenerate off whatever
  // prompt happens to come next.
  if (initialTranscript.length > 0) {
    const { sessionTitleActions } = await import("@/store/index.ts");
    const { seedResumedSessionTitle } = await import("@/engine/session/title/store.ts");
    const forSessionId = session.id;
    seedResumedSessionTitle(sessionTitleActions, forSessionId, () => session.id === forSessionId);
  }
  const stringViewRoot = buildStringViewRoot(cfg, turnDispatch, initialTranscript);
  // Built after the root seeds the transcript so it reads the settled emptiness: a
  // fresh session gets the banner, a resumed one gets a one-row shell margin.
  const welcomePrelude = createWelcomePrelude(OTHERSIDE_VERSION);
  const prelude = (width: number) => applyBootPreludeMargin(welcomePrelude(width));
  // Seed resume context (% used) + publish the derived token counter / notices.
  // Must run after the root is built so the status line's first paint sees seed.
  const deactivateUsage = activateStringViewUsage({
    session,
    broker,
    initialTranscript,
    runtimeConfig: cfg,
  });
  // Live binding reloads: the file was read at boot, and this keeps it matching
  // while the session runs plus says once when something in it was refused.
  const { watchBindingFile } = await import("@/ui/keys/binding-watch.ts");
  const stopBindingWatch = watchBindingFile();
  const { activateStringViewRemoteSync } = await import(
    "@/ui/app/remote/string-view-remote-sync.ts"
  );
  const deactivateRemoteSync = activateStringViewRemoteSync({ session, broker });
  const { startWindowCaption } = await import("@/ui/chrome/window-caption.ts");
  const stopWindowCaption = startWindowCaption();
  // Focus-gain clipboard hint: only when the live route can accept images.
  const { canSendNatively, autoRoutesNonVision } = await import(
    "@/engine/model/facts/capabilities-runtime.ts"
  );
  const { createClipboardAttentionProbe } = await import(
    "@/ui/input/paste/clipboard-image-hint.ts"
  );
  const clipboardImageProbe = createClipboardAttentionProbe(() => {
    const route = broker.read();
    return (
      canSendNatively(route.provider, route.model) ||
      autoRoutesNonVision(route.provider) ||
      Boolean(cfg.imageParserProvider)
    );
  });
  const { reportWindowAttention } = await import("@/store/window-attention/index.ts");
  inlineController = openStringView(stringViewRoot, {
    confirmInterruptExit: true,
    onExitHintChange: setExitHintArmed,
    prelude,
    onWindowAttention: (active) => {
      reportWindowAttention(active);
      clipboardImageProbe(active);
    },
  });
  leaveSession = () => inlineController.close();
  const { setSurfaceRedraw } = await import("@/ui/app/redraw.ts");
  setSurfaceRedraw(() => inlineController.redraw());
  const { activateStringViewBackgroundCompletions } = await import(
    "@/ui/app/dispatch/string-view-background-completions.ts"
  );
  const deactivateBackgroundCompletions = activateStringViewBackgroundCompletions({
    requestRepaint: inlineController.repaint,
    requestBackgroundResume: turnDispatch.requestBackgroundResume,
  });
  const { registerSession, unregisterSession, touchSession, isSessionAlive } = await import(
    "@/engine/session/registry.ts"
  );
  registerSession(session.id, session.cwd);
  // Reclaim paste-image caches from sessions that no longer exist, off the render path.
  const { cleanupStaleImageCaches } = await import("@/kernel/storage/paste-image-cache.ts");
  cleanupStaleImageCaches(session.id, isSessionAlive);
  // The goal indicator, resume-id, and task artifact routing resolve the active
  // session through getActiveSessionId(); populate it on the interactive path.
  setTaskOutputSession({ sessionId: session.id, cwd: session.cwd });
  const heartbeat = setInterval(() => {
    touchSession(session.id, session.cwd);
  }, REGISTRY_HEARTBEAT_MS);
  heartbeat.unref();
  await appendStartupNotices(agentFailures ?? []);
  void import("@/kernel/mcp/index.ts").then(({ mcpStartupNotices }) =>
    mcpStartupNotices(process.cwd())
      .then(async ({ notices, failedCount }) => {
        submitMcpFailuresNotice(failedCount);
        await appendStartupNotices(notices);
      })
      .catch(() => {}),
  );
  try {
    await inlineController.finished();
  } finally {
    turnDispatch.dispose();
    deactivateBackgroundCompletions();
    deactivateUsage();
    stopBindingWatch();
    deactivateRemoteSync();
    stopWindowCaption();
    clearInterval(heartbeat);
    unregisterSession(session.id);
    const { stopAllDesign } = await import("@/design/index.ts");
    await stopAllDesign();
  }
  const showResumeHint = process.stdout.isTTY && hasSessionTranscript(session);
  await drainPendingAsyncRewakeHooks();
  await fireConfiguredHooks(cfg, "sessionEnd", {
    kind: "sessionEnd",
    ctx: { sessionId: session.id, cwd: session.cwd, reason: "prompt_input_exit" },
  });
  await finalizeSession(session);
  if (showResumeHint) {
    // A kept worktree is part of the resume command: rejoining the session
    // means re-entering its worktree.
    const { latchedWorktreeName } = await import("@/engine/session/worktree.ts");
    // Take the whole row before clearing: teardown leaves the cursor parked on the
    // prompt caret, so erasing from where it stands would keep the prompt's own
    // opening on screen with nothing after it.
    // Read the title back off the transcript rather than from the in-session store:
    // resume looks up the persisted rename, so that is the one the command must name.
    const { loadCustomSessionTitle } = await import("@/engine/session/title/store.ts");
    const customTitle = await loadCustomSessionTitle(session.id).catch(() => null);
    process.stdout.write(
      `\r${ERASE_DISPLAY_TO_END}${resumeExitText(session.id, "otherside", latchedWorktreeName(), customTitle)}`,
    );
  }
  process.exit(0);
}
