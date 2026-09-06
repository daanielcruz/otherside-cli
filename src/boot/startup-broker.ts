import { devtoolString } from "@/devtools/settings.ts";
import {
  defaultEffortForModel,
  defaultModelForProvider,
  effortLevelsForModel,
  ensureRuntimeModel,
  findModel,
  findUniqueModel,
  pickInitialModel,
  resolveModelId,
} from "@/engine/model/catalog.ts";
import {
  loadSessionForResume,
  resolveSessionBrokerState,
  type SessionBrokerState,
} from "@/engine/session/index.ts";
import {
  effectiveOrchestrationMode,
  fastModeForProvider,
  type loadConfig,
} from "@/kernel/config/config.ts";
import { asEffortLevel } from "@/kernel/std/types/effort.ts";
import { isProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import {
  type CredentialsBundle,
  hasCredential,
  type loadAll as loadAllCredentials,
  type loadFor as loadCredentialsFor,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import type { CliMode } from "@/modes/args.ts";
import { Broker } from "@/store/app-store/broker.ts";

export type StartupMode = Extract<CliMode, { kind: "interactive" } | { kind: "print" }>;

export function hasLoadedCredential(provider: ProviderSlug, credential: unknown): boolean {
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
  const model = resolveModelId({ provider: providerValue, model: modelValue });
  return {
    ...state,
    provider: providerValue,
    model,
    effort: defaultEffortForModel({ provider: providerValue, model }),
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
    cliProviderRaw ?? (cliModelRaw ? (findUniqueModel(cliModelRaw)?.provider ?? null) : null);
  const cliOverrides = {
    // `--effort` is honoured wherever it is accepted. A level the catalog does not know
    // is left out rather than carried: it would name a state the model cannot be in.
    effort: asEffortLevel(mode.effort),
    permissionMode: mode.permissionMode,
  };
  const FALLBACK_ORDER: Array<typeof cfg.defaultProvider> = [
    "anthropic",
    "codex",
    "kimi",
    "openai",
  ];
  const credsForProvider = (p: typeof cfg.defaultProvider): boolean => {
    if (p === "openai") return Boolean(customCreds);
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
  const defaultInitialModel = resolveModelId({
    provider: defaultInitialProvider,
    model:
      cliModelRaw ??
      pickInitialModel({
        provider: defaultInitialProvider,
        savedDefaultProvider: cfg.defaultProvider,
        savedDefaultModel: cfg.defaultModel,
      }),
  });
  const defaultBrokerState: SessionBrokerState = {
    provider: defaultInitialProvider as typeof cfg.defaultProvider,
    model: defaultInitialModel,
    effort:
      cliOverrides.effort ??
      cfg.effortLevel ??
      defaultEffortForModel({
        provider: defaultInitialProvider as typeof cfg.defaultProvider,
        model: defaultInitialModel,
      }),
    fastMode: fastModeForProvider(cfg, defaultInitialProvider as typeof cfg.defaultProvider),
    orchestrationMode: effectiveOrchestrationMode(cfg),
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
  // Bypass (yolo) wins over an explicit --permission-mode with a bypass-first
  // ordering: --yolo/--dangerously-skip-permissions
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
      orchestrationMode: restoredBrokerState.orchestrationMode ?? effectiveOrchestrationMode(cfg),
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
