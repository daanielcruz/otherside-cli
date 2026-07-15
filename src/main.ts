import "@/devtools/bootstrap.ts";
import { createElement } from "react";
import { devtoolBoolean, devtoolString } from "@/devtools/settings.ts";
import "@/engine/background/tasks/background.ts";
import "@/engine/background/workflows/runtime/store/store.ts";
import "@/engine/providers/usage-quota-snapshot.ts";
import "@/engine/queue/emit.ts";
import "@/engine/session/usage/limits.ts";
import { maybeReexecWithAllocLever } from "@/devtools/memory/allocator.ts";
import { installGcCadence } from "@/devtools/memory/gc-cadence.ts";
import { installHeapDumpTrigger } from "@/devtools/memory/heap-dump.ts";
import { startCronScheduler } from "@/engine/background/cron/scheduler.ts";
import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import { startSharedOutputPoller } from "@/engine/background/tasks/output-poller.ts";
import { runLogout } from "@/engine/contract/login.ts";
import { pricingFor } from "@/engine/contract/pricing.ts";
import { loadCorpus } from "@/engine/corpus.ts";
import {
  defaultEffortForModel,
  defaultModelForProvider,
  effortLevelsForModel,
  ensureRuntimeModel,
  findModel,
  pickInitialModel,
  registerRuntimeModel,
  resolveModelId,
} from "@/engine/model/catalog.ts";
import { seedExtraUsageDisabledReason } from "@/engine/providers/anthropic/access.ts";
import { Agent } from "@/engine/queue/index.ts";
import { restoreGoalFromRecords } from "@/engine/queue/state.ts";
import {
  finalizeSession,
  hasMessageRecords,
  loadSessionForResume,
  migrateLegacySessions,
  resolveSessionBrokerState,
  resumeExitText,
  Session,
  type SessionBrokerState,
  sessionMetaFromBrokerState,
} from "@/engine/session/index.ts";
import type { ContentReplacementSessionRecord } from "@/engine/session/record/schema.ts";
import { scheduleRetentionCleanup } from "@/engine/session/retention.ts";
import {
  createContentReplacementState,
  reconstructContentReplacementState,
} from "@/engine/tool-result-storage/index.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import * as tools from "@/engine/tools/registry.ts";
import { bootstrapLlmApiRegistry } from "@/engine/translator/bootstrap.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { registerBuiltinClassifiers } from "@/engine/transport/errors.ts";
import { initScratchpadDir } from "@/harness/routines/scratchpad.ts";
import {
  type FrameMetrics,
  inputLagTraceEnabled,
  OSC,
  recordInputLag,
  render,
  startEventLoopMonitor,
  wrapForSessionManager,
} from "@/ink";
import { registerPermissionPushEmitter } from "@/kernel/channels/permission.ts";
import {
  claimInitialSetupHook,
  fastModeForProvider,
  loadConfig,
  loadConfigSync,
} from "@/kernel/config/config.ts";
import { isProviderId, PROVIDER_ID_VALUES, type ProviderId } from "@/kernel/config/provider-ids.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { fireConfiguredHooks, fireSetupHooksInBackground } from "@/kernel/hooks/handler.ts";
import { refreshMcpTools, setMcpToolRegistry } from "@/kernel/mcp/index.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { installEpipeGuard } from "@/kernel/std/proc/epipe.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { installWatchdogCaptureHooks } from "@/kernel/std/stream/debug-capture.ts";
import {
  emitTerminalProgress,
  setTerminalProgressSequenceBuilder,
  type TerminalProgressState,
} from "@/kernel/std/terminal-progress.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import {
  type CredentialsBundle,
  hasCredential,
  loadAll as loadAllCredentials,
  loadFor as loadCredentialsFor,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import { type CliMode, parseArgs } from "@/modes/args.ts";
import { runPrintMode } from "@/modes/print/index.ts";
import { emitPushEvent } from "@/remote/index.ts";
import { Broker } from "@/store/app-store/broker.ts";
import { bootSubscribers } from "@/store/subscribers/index.ts";
import {
  ITERM2_COMMANDS,
  osc,
  PROGRESS_STATES,
} from "@/terminal-runtime/terminal/operating-system-command.ts";
import { App, sessionRecordsToMessages, sessionRecordsToTranscript } from "@/ui/index.ts";
import { resolveThemeSetting } from "@/ui/theme/system-theme.ts";
import { setActiveTheme } from "@/ui/theme/theme.ts";
import { installTerminalRestoreOnExit } from "@/utils/gracefulShutdown.ts";
import pkg from "../package.json" with { type: "json" };

const VERSION = pkg.version;
const REGISTRY_HEARTBEAT_MS = 30_000;
const INK_DEVTOOLS_PORT = 8097;
const ANSI_RED = "\u001b[31m";
const ANSI_FOREGROUND_RESET = "\u001b[39m";
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

export function formatDirectResumeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${ANSI_RED}${message}${ANSI_FOREGROUND_RESET}\n`;
}

maybeReexecWithAllocLever();

if (typeof process.stdout.setMaxListeners === "function") process.stdout.setMaxListeners(0);
if (typeof process.stderr.setMaxListeners === "function") process.stderr.setMaxListeners(0);
if (typeof process.stdin.setMaxListeners === "function") process.stdin.setMaxListeners(0);

installEpipeGuard();

process.env.OTHERSIDE_EXECPATH = process.execPath;

installHeapDumpTrigger();
installGcCadence();
registerPermissionPushEmitter(emitPushEvent);

async function maybeRunTerminalMode(mode: CliMode): Promise<boolean> {
  if (mode.kind === "error") {
    process.stderr.write(`${mode.message}\n`);
    process.exit(mode.code);
  }
  if (mode.kind === "version") {
    process.stdout.write(`otherside ${VERSION}\n`);
    return true;
  }
  if (mode.kind === "help") {
    process.stdout.write(
      [
        `otherside ${VERSION} — multi-provider coding agent`,
        "",
        "usage:",
        "  otherside              interactive TUI",
        "  otherside --yolo       skip permission prompts",
        "  otherside --permission-mode <default|accept-edits|plan|yolo>",
        "  otherside --resume <id> resume a saved session",
        "  otherside -c | --continue resume the most recent session for the current cwd",
        "  otherside --provider antigravity --model gemini-3.1-pro-high",
        "  otherside logout --provider antigravity",
        "  otherside --version",
        "",
      ].join("\n"),
    );
    return true;
  }
  if (mode.kind === "logout") {
    const lines = await runLogout(mode.provider);
    process.stdout.write(`${lines.join("\n")}\n`);
    return true;
  }
  if (mode.kind === "statusline") {
    const { runStatuslineMode } = await import("@/modes/statusline/index.ts");
    await runStatuslineMode();
    return true;
  }
  if (mode.kind === "piped") {
    process.stdout.write(`piped mode — Phase 12\n`);
    process.exit(1);
  }
  return false;
}

async function loadStartupConfig(cwd: string) {
  const cfg = resolveConfig(cwd);
  setActiveTheme(resolveThemeSetting(cfg.theme ?? "auto"));
  const allCreds = await loadAllCredentials();
  const customCreds = await loadCredentialsFor("openai-custom");
  if (customCreds?.contextWindow && (customCreds.model || cfg.defaultModel)) {
    const model = customCreds.model || cfg.defaultModel;
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: customCreds.contextWindow,
      provider: "openai-custom",
      efforts: [],
      defaultEffort: null,
    });
  }
  loadCorpus();
  seedExtraUsageDisabledReason(cfg.cachedExtraUsageDisabledReason);
  migrateLegacySessions();
  scheduleRetentionCleanup();
  return { cfg, allCreds, customCreds };
}

type StartupMode = Extract<CliMode, { kind: "interactive" } | { kind: "print" }>;

function hasLoadedCredential(provider: ProviderSlug, credential: unknown): boolean {
  return hasCredential({ [provider]: credential } as CredentialsBundle, provider);
}

function overrideResumeBrokerForDevtools(
  state: SessionBrokerState,
  isResume: boolean,
): SessionBrokerState {
  if (!isResume) return state;
  const providerValue = devtoolString("resumeProvider");
  const modelValue = devtoolString("resumeModel");
  if (providerValue === undefined && modelValue === undefined) return state;
  if (!isProviderId(providerValue) || modelValue === undefined) {
    throw new Error("devtools resume provider and model overrides must both be valid");
  }
  ensureRuntimeModel(modelValue, providerValue);
  const model = resolveModelId(modelValue, providerValue);
  return {
    ...state,
    provider: providerValue,
    model,
    effort: defaultEffortForModel(model, providerValue),
    fastMode: undefined,
  };
}

export function resolveStartupBroker(args: {
  mode: StartupMode;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  allCreds: Awaited<ReturnType<typeof loadAllCredentials>>;
  customCreds: Awaited<ReturnType<typeof loadCredentialsFor>>;
  resumeRecords: Awaited<ReturnType<typeof loadSessionForResume>>["records"];
  isResume: boolean;
}) {
  const { mode, cfg, allCreds, customCreds, resumeRecords, isResume } = args;
  const cliProviderRaw = mode.provider;
  const cliModelRaw = mode.model;
  // `--model` of a non-active provider with no `--provider` resolves to that
  // model's provider via the catalog, instead of mis-routing it to the default
  // provider (which sent e.g. a MiniMax model to api.anthropic.com → 404).
  const cliProvider =
    cliProviderRaw ?? (cliModelRaw ? (findModel(cliModelRaw)?.provider ?? null) : null);
  const cliOverrides = {
    effort:
      mode.kind === "print"
        ? ((mode.effort as ReturnType<typeof defaultEffortForModel> | null | undefined) ??
          undefined)
        : undefined,
    permissionMode: mode.permissionMode,
  };
  const FALLBACK_ORDER: Array<typeof cfg.defaultProvider> = [
    "anthropic",
    "codex",
    "kimi-code",
    "openai-custom",
  ];
  const credsForProvider = (p: typeof cfg.defaultProvider): boolean => {
    if (p === "openai-custom") return Boolean(customCreds);
    return hasCredential(allCreds, p as ProviderSlug);
  };
  let defaultInitialProvider = (cliProvider ?? cfg.defaultProvider) as typeof cfg.defaultProvider;
  if (!cliProvider && !credsForProvider(defaultInitialProvider)) {
    const fallback = FALLBACK_ORDER.find((p) => credsForProvider(p));
    if (fallback) defaultInitialProvider = fallback;
  }
  if (cliModelRaw) {
    ensureRuntimeModel(cliModelRaw, defaultInitialProvider);
  } else if (cfg.defaultModel && cfg.defaultProvider === defaultInitialProvider) {
    ensureRuntimeModel(cfg.defaultModel, defaultInitialProvider);
  }
  const defaultInitialModel = resolveModelId(
    cliModelRaw ??
      pickInitialModel({
        provider: defaultInitialProvider,
        savedDefaultProvider: cfg.defaultProvider,
        savedDefaultModel: cfg.defaultModel,
      }),
    defaultInitialProvider,
  );
  const defaultBrokerState: SessionBrokerState = {
    provider: defaultInitialProvider as typeof cfg.defaultProvider,
    model: defaultInitialModel,
    effort:
      cliOverrides.effort ??
      cfg.effortLevel ??
      defaultEffortForModel(
        defaultInitialModel,
        defaultInitialProvider as typeof cfg.defaultProvider,
      ),
    fastMode: fastModeForProvider(cfg, defaultInitialProvider as typeof cfg.defaultProvider),
  };
  const persistedBrokerState = isResume
    ? resolveSessionBrokerState(resumeRecords, defaultBrokerState)
    : defaultBrokerState;
  const restoredBrokerState = overrideResumeBrokerForDevtools(persistedBrokerState, isResume);
  const initialFastMode =
    restoredBrokerState.fastMode ?? fastModeForProvider(cfg, restoredBrokerState.provider);
  // Headless (`--print`) defaults to `default` (prompt-requiring tools are then
  // auto-denied — it must not silently mutate); interactive keeps accept-edits.
  const fallbackPermissionMode: PermissionMode = mode.kind === "print" ? "default" : "accept-edits";
  // Bypass (yolo) wins over an explicit --permission-mode, mirroring upstream's
  // bypass-first ordering (permissionSetup.ts): --yolo/--dangerously-skip-permissions
  // must fail open even when paired with e.g. `--permission-mode plan`.
  const initialPermissionMode: PermissionMode = mode.yolo
    ? "yolo"
    : (cliOverrides.permissionMode ?? cfg.defaultMode ?? fallbackPermissionMode);
  const broker = new Broker(
    {
      provider: restoredBrokerState.provider,
      model: restoredBrokerState.model,
      effort: restoredBrokerState.effort,
      fastMode: initialFastMode,
      permissionMode: initialPermissionMode,
    },
    { findModel, effortLevelsForModel, defaultEffortForModel, defaultModelForProvider },
  );
  // Ultracode is session-scoped: a resumed session restores its own recorded
  // state (its effort was already seeded into the broker above); a fresh session,
  // or a pre-persistence resume that recorded no ultracode, falls back to config.
  if (restoredBrokerState.ultracode !== undefined) {
    if (restoredBrokerState.ultracode) {
      broker.dispatch({
        kind: "set_ultracode",
        enabled: true,
        effort: restoredBrokerState.effort ?? cfg.ultracodeEffort ?? "high",
      });
    }
  } else if (cfg.ultracode) {
    broker.dispatch({
      kind: "set_ultracode",
      enabled: true,
      effort: cfg.ultracodeEffort ?? "high",
    });
  }
  const cliProviderMissingCreds =
    cliProvider !== null && !credsForProvider(cliProvider as typeof cfg.defaultProvider);
  return {
    broker,
    initialProvider: restoredBrokerState.provider,
    initialModel: restoredBrokerState.model,
    cliProviderRaw: cliProvider,
    cliProviderMissingCreds,
  };
}

async function runPrintEntrypoint(args: {
  mode: Extract<CliMode, { kind: "print" }>;
  agent: Agent;
  session: Session;
  broker: Broker;
  initialProvider: string;
  initialModel: string;
  customCreds: Awaited<ReturnType<typeof loadCredentialsFor>>;
}): Promise<void> {
  const { mode, agent, session, broker, initialProvider, initialModel, customCreds } = args;
  const traceOn = mode.verbose || devtoolBoolean("trace");
  const trace = (msg: string): void => {
    if (traceOn) process.stderr.write(`[print-trace] ${msg}\n`);
  };
  trace("checking credentials");
  const activeProvider = initialProvider as ProviderSlug;
  const activeCreds =
    activeProvider === "openai-custom" ? customCreds : await loadCredentialsFor(activeProvider);
  if (!hasLoadedCredential(activeProvider, activeCreds)) {
    process.stderr.write(
      `otherside: no credentials for provider ${initialProvider}; launch \`otherside\` and sign in via /login first\n`,
    );
    process.exit(2);
  }
  trace(`credentials ok, provider=${initialProvider} model=${initialModel}`);
  // SIGINT in headless mode aborts the in-flight turn and exits cleanly (0),
  // rather than the default ~130 — a Ctrl-C in a script is not a failure.
  process.once("SIGINT", () => {
    agent.cancel();
    process.exit(0);
  });
  trace("running print mode");
  const agentRegistry = await import("@/engine/agents/registry.ts");
  const skillRegistry = await import("@/engine/skills/registry.ts");
  const { CATALOG: SLASH_CATALOG } = await import("@/commands/catalog.ts");
  const { loadMcpConfigChain, mergeChildWins } = await import("@/kernel/mcp/config.ts");
  const mcpChain = await loadMcpConfigChain(process.cwd()).catch(() => []);
  const mergedMcp = mergeChildWins(mcpChain);
  const mcpServers = Object.keys(mergedMcp.config.mcpServers ?? {});
  const exitCode = await runPrintMode(
    agent,
    mode.prompt,
    mode.outputFormat,
    {
      sessionId: session.id,
      cwd: process.cwd(),
      model: initialModel,
      permissionMode: broker.read().permissionMode,
      verbose: mode.verbose,
      contextWindow: findModel(initialModel)?.contextWindow ?? 0,
      pricing: pricingFor(initialProvider as ProviderId, initialModel),
      maxTurns: mode.maxTurns,
      toolNames: tools.list().map((t) => t.schema.name),
      slashCommands: SLASH_CATALOG.map((s) => s.name),
      agentNames: agentRegistry.list().map((a) => a.name),
      skillNames: skillRegistry.list().map((s) => s.name),
      mcpServers,
      version: VERSION,
    },
    trace,
  );
  trace(`print mode done exit=${exitCode}`);
  await fireConfiguredHooks(loadConfigSync(), "sessionEnd", {
    kind: "sessionEnd",
    ctx: { sessionId: session.id, cwd: session.cwd, reason: "other" },
  });
  process.exit(exitCode);
}

async function installInkDevtools(): Promise<void> {
  if (!devtoolBoolean("inkDevtools")) return;
  try {
    // react-devtools-core's backend reaches for the browser `window` global, which
    // bun does not define; alias it to globalThis so the DevTools hook lands on the
    // same global the reconciler reads `__REACT_DEVTOOLS_GLOBAL_HOOK__` from. The
    // reconciler is already loaded (the "ink" barrel imports it), so this resolves
    // the same singleton and registers it explicitly (production React never
    // self-registers — it only injects via injectIntoDevTools).
    (globalThis as { window?: unknown }).window ??= globalThis;
    const devtools = await import("react-devtools-core");
    const reconciler = (await import("@/terminal-runtime/tree/react-adapter.ts")).default as {
      injectIntoDevTools?: () => void;
    };
    devtools.initialize();
    reconciler.injectIntoDevTools?.();
    devtools.connectToDevTools({ host: "localhost", port: INK_DEVTOOLS_PORT });
  } catch {}
}

async function runInteractiveEntrypoint(args: {
  agent: Agent;
  broker: Broker;
  session: Session;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  allCreds: Awaited<ReturnType<typeof loadAllCredentials>>;
  cliProviderMissingCreds: boolean;
  cliProviderRaw: string | null;
  resumeRecords: Awaited<ReturnType<typeof loadSessionForResume>>["records"];
}): Promise<void> {
  const {
    agent,
    broker,
    session,
    cfg,
    allCreds,
    cliProviderMissingCreds,
    cliProviderRaw,
    resumeRecords,
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
    process.stdout.write("\x1b]0;Otherside CLI\x1b\\");
    installTerminalRestoreOnExit();
    emitTerminalProgress("completed");
  }

  startEventLoopMonitor();
  installWatchdogCaptureHooks();
  startSharedOutputPoller();
  bootSubscribers({ broker });
  await installInkDevtools();
  const instance = await render(
    createElement(App, {
      broker,
      session,
      agent,
      config: cfg,
      version: VERSION,
      initialTranscript: sessionRecordsToTranscript(resumeRecords),
      ...(overlayChain.length > 0
        ? {
            initialOverlayChain: overlayChain,
            ...(needsLogin && !cliProviderMissingCreds ? { greeting: "Welcome to otherside" } : {}),
          }
        : {}),
      ...(initialLoginProvider ? { initialLoginProvider } : {}),
    }),
    {
      exitOnCtrlC: false,
      ...(inputLagTraceEnabled()
        ? { onFrame: (event: FrameMetrics) => recordInputLag("paint", event.durationMs) }
        : {}),
    },
  );
  const { registerSession, unregisterSession, touchSession } = await import(
    "@/engine/session/registry.ts"
  );
  registerSession(session.id, session.cwd);
  const heartbeat = setInterval(() => {
    touchSession(session.id, session.cwd);
  }, REGISTRY_HEARTBEAT_MS);
  heartbeat.unref();
  void import("@/kernel/mcp/index.ts").then(({ warnOnMcpFailures }) =>
    warnOnMcpFailures(process.cwd()).catch(() => {}),
  );
  try {
    await instance.waitUntilExit();
  } finally {
    clearInterval(heartbeat);
    unregisterSession(session.id);
    const { stopAllDesign } = await import("@/design/index.ts");
    await stopAllDesign();
  }
  await fireConfiguredHooks(cfg, "sessionEnd", {
    kind: "sessionEnd",
    ctx: { sessionId: session.id, cwd: session.cwd, reason: "prompt_input_exit" },
  });
  await finalizeSession(session);
  if (hasMessageRecords(session)) {
    // Clear below the cursor first: the inline renderer's teardown leaves the
    // final frame rows on screen, and the hint would overprint them.
    process.stdout.write(`\u001b[0J${resumeExitText(session.id)}`);
  }
  process.exit(0);
}

export async function buildResumedSession(args: {
  effectiveResumeId: string | null;
  resumeRecords: Awaited<ReturnType<typeof loadSessionForResume>>["records"];
  resumeUsageRecords: Awaited<ReturnType<typeof loadSessionForResume>>["usageRecords"];
  chainHead: Awaited<ReturnType<typeof loadSessionForResume>>["chainHead"];
  resumeCwd?: Awaited<ReturnType<typeof loadSessionForResume>>["cwd"];
  isResume: boolean;
  broker: Broker;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  isPrint?: boolean;
}): Promise<{ session: Session; agent: Agent }> {
  const {
    effectiveResumeId,
    resumeRecords,
    resumeUsageRecords,
    chainHead,
    resumeCwd,
    isResume,
    broker,
    cfg,
    isPrint,
  } = args;
  const sessionCwd = isResume && resumeCwd ? resumeCwd : process.cwd();
  const session = new Session(effectiveResumeId ?? uuidv4(), sessionCwd);
  setTrackedCwd(session.cwd);
  initScratchpadDir(session.cwd, session.id);
  setTaskOutputSession({ sessionId: session.id, cwd: session.cwd });
  const { currentGitBranch } = await import("@/engine/session/paths.ts");
  const gitBranch = currentGitBranch(session.cwd);
  if (gitBranch) session.gitBranch = gitBranch;
  for (const record of resumeRecords) session.pushRecord(record);
  for (const record of resumeUsageRecords) session.pushUsageRecord(record);
  if (isResume) restoreGoalFromRecords(session.id, resumeRecords);
  if (isResume && chainHead) {
    session.chain.seed(chainHead);
  }
  session.messages.push(...sanitizeMessages(sessionRecordsToMessages(resumeRecords)));
  if (isResume) {
    const replacementRecords = resumeRecords
      .filter((r): r is ContentReplacementSessionRecord => r.type === "content_replacement")
      .map((r) => ({
        kind: r.kind,
        toolUseId: r.toolUseId,
        replacement: r.replacement,
      }));
    session.contentReplacementState = reconstructContentReplacementState(
      session.messages,
      replacementRecords,
    );
  } else {
    session.contentReplacementState = createContentReplacementState();
  }
  const { nowIso } = await import("@/engine/session/record/index.ts");
  if (!isResume) {
    session.pendingMeta = sessionMetaFromBrokerState(session, broker.read(), nowIso());
  }
  const { getLastUsage } = await import("@/engine/session/compact/last-usage.ts");
  const agent = new Agent({ broker, session, config: cfg, getLastUsage });
  if (isResume) {
    const { replayInjectionsFromRecords } = await import("@/engine/session/resume.ts");
    replayInjectionsFromRecords(resumeRecords, agent);
  }
  if (!isPrint) {
    const { probeQuotaStatus } = await import("@/engine/providers/anthropic/quota-probe.ts");
    void probeQuotaStatus(broker);
  }
  return { session, agent };
}

async function main(): Promise<void> {
  bootstrapLlmApiRegistry();
  registerBuiltinClassifiers();
  const mode = parseArgs(Bun.argv);
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
  const { cfg, allCreds, customCreds } = await loadStartupConfig(process.cwd());
  if (shouldFireSetupHook) fireSetupHooksInBackground(cfg, "init");
  const mcpBootLoad = refreshMcpTools(process.cwd()).catch(() => {});

  let effectiveResumeId: string | null = null;
  if (mode.kind === "interactive" || mode.kind === "print") {
    if (mode.resumeSessionId) {
      effectiveResumeId = mode.resumeSessionId;
    } else if (mode.resumeLatest) {
      const { latestSessionId } = await import("@/engine/session/paths.ts");
      effectiveResumeId = latestSessionId(process.cwd());
      if (effectiveResumeId === null) {
        process.stderr.write(
          formatDirectResumeError(new Error("No conversation found to continue")),
        );
        // Nothing interactive has mounted; exit directly so in-flight startup
        // work (MCP refresh, hooks) cannot hold the event loop open.
        process.exit(1);
      }
    }
  }
  let resumeLoad: Awaited<ReturnType<typeof loadSessionForResume>>;
  try {
    resumeLoad = effectiveResumeId
      ? await loadSessionForResume(effectiveResumeId)
      : { records: [], usageRecords: [], chainHead: null, cwd: null };
  } catch (error) {
    process.stderr.write(formatDirectResumeError(error));
    // Same as above: pre-mount failure must not wait for startup promises.
    process.exit(1);
  }
  const resumeRecords = resumeLoad.records;
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
    resumeUsageRecords: resumeLoad.usageRecords,
    chainHead: resumeLoad.chainHead,
    resumeCwd: resumeLoad.cwd,
    isResume,
    broker,
    cfg,
    isPrint: mode.kind === "print",
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
    // A piped prompt (`echo … | otherside -p`) fills an otherwise-empty prompt.
    if (mode.prompt.trim().length === 0 && !process.stdin.isTTY) {
      mode.prompt = (await Bun.stdin.text()).trim();
    }
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
    resumeRecords,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
