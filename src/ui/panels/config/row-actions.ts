import { listProviderConfigs } from "@/engine/contract/registry.ts";
import { availableModelsForProvider, defaultModelForProvider } from "@/engine/model/catalog.ts";
import {
  resolveParserModel,
  visionCapableProviderIds,
} from "@/engine/model/facts/capabilities-runtime.ts";
import {
  fastModeForProvider,
  normalizeWorkflowSizeClass,
  type UserConfig,
  type WorkflowSizeClass,
} from "@/kernel/config/config.ts";
import { DEFAULT_EDITOR_MODE } from "@/kernel/config/editor-mode.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import {
  IMAGE_GENERATOR_PROVIDER_ID_VALUES,
  type ImageGeneratorSelection,
  type ProviderId,
  VOICE_PROVIDER_ID_VALUES,
  type VoiceProviderSelection,
} from "@/kernel/std/types/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import {
  type CredentialsBundle,
  hasCredential,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import {
  cycle,
  cycleOrchestrationMode,
  WORKFLOW_SIZE_CLASS_OPTIONS,
} from "@/ui/panels/config/rows.ts";

/** A provider/model/fast-mode pick the panel holds until Escape commits it. */
export type PendingProvider = {
  provider: ProviderId;
  model: string;
  fastMode: boolean;
};

const PERMISSION_MODES: PermissionMode[] = ["default", "accept-edits", "plan", "yolo"];

/**
 * What a bool row toggle does beyond the config patch: broker-side effects the
 * panel applies after persisting.
 */
export type BoolToggleEffect =
  | { kind: "fastMode"; enabled: boolean }
  | { kind: "orchestrationMode"; mode: OrchestrationMode }
  | { kind: "verbose"; verbose: boolean };

export function cycledProviderRoute(
  cfg: UserConfig,
  credentials: CredentialsBundle | null,
  currentProvider: ProviderId,
  direction: number,
): PendingProvider | null {
  const eligible = listProviderConfigs()
    .map((c) => c.provider.id)
    .filter((id) => hasCredential(credentials, id as ProviderSlug));
  if (eligible.length === 0) return null;
  const start = eligible.includes(currentProvider) ? currentProvider : eligible[0];
  if (!start) return null;
  const provider = cycle(eligible, start, direction);
  return {
    provider,
    model: defaultModelForProvider(provider),
    fastMode: fastModeForProvider(cfg, provider),
  };
}

export function cycledModelRoute(
  state: Readonly<BrokerState>,
  fastMode: boolean,
  direction: number,
): PendingProvider | null {
  const models = availableModelsForProvider(state.provider).map((m) => m.id);
  if (models.length === 0) return null;
  return { provider: state.provider, model: cycle(models, state.model, direction), fastMode };
}

export function cycledPermissionMode(current: PermissionMode, direction: number): PermissionMode {
  return cycle(PERMISSION_MODES, current, direction);
}

export function cycledImageGeneratorConfig(
  cfg: UserConfig,
  credentials: CredentialsBundle | null,
  direction: number,
): UserConfig {
  const configured = IMAGE_GENERATOR_PROVIDER_ID_VALUES.filter((provider) =>
    hasCredential(credentials, provider),
  );
  const current = cfg.imageGenProvider ?? "off";
  const options: ImageGeneratorSelection[] = ["off", ...configured];
  const next = cycle(options, current, direction || 1);
  return { ...cfg, imageGenProvider: next };
}

export function cycledVoiceProviderConfig(
  cfg: UserConfig,
  credentials: CredentialsBundle | null,
  direction: number,
): UserConfig {
  const configured = VOICE_PROVIDER_ID_VALUES.filter((provider) =>
    hasCredential(credentials, provider),
  );
  const current = cfg.voiceProvider ?? "off";
  const options: VoiceProviderSelection[] = ["off", ...configured];
  if (!options.includes(current)) options.push(current);
  const next = cycle(options, current, direction || 1);
  const patch: UserConfig = { ...cfg };
  if (next === "off") delete patch.voiceProvider;
  else patch.voiceProvider = next;
  return patch;
}

export function cycledImageParserProviderConfig(
  cfg: UserConfig,
  credentials: CredentialsBundle | null,
  sessionProvider: ProviderId,
  direction: number,
): UserConfig {
  const eligible = visionCapableProviderIds()
    .filter((id) => id !== sessionProvider)
    .filter((id) => hasCredential(credentials, id as ProviderSlug));
  const options = ["off", ...eligible] as const;
  const current = cfg.imageParserProvider ?? "off";
  const next = cycle(options as readonly string[], current, direction || 1);
  const patch: UserConfig = { ...cfg };
  if (next === "off") {
    delete patch.imageParserProvider;
    delete patch.imageParserModel;
  } else {
    patch.imageParserProvider = next as ProviderId;
    patch.imageParserModel = resolveParserModel(next as ProviderId);
  }
  return patch;
}

export function cycledImageParserModelConfig(
  cfg: UserConfig,
  direction: number,
): UserConfig | null {
  const provider = cfg.imageParserProvider;
  if (!provider) return null;
  const models = availableModelsForProvider(provider).map((m) => m.id);
  if (models.length === 0) return null;
  const current = cfg.imageParserModel ?? resolveParserModel(provider);
  const next = cycle(models, current, direction || 1);
  return { ...cfg, imageParserModel: next };
}

export function cycledWorkflowSizeConfig(cfg: UserConfig, direction: number): UserConfig {
  // undefined = the default (medium) state; cycling can reach and leave it.
  const options: (WorkflowSizeClass | undefined)[] = [undefined, ...WORKFLOW_SIZE_CLASS_OPTIONS];
  const current = normalizeWorkflowSizeClass(cfg.workflowSizeGuideline);
  const step = direction || 1;
  const index = options.indexOf(current);
  const next = options[(index + step + options.length) % options.length];
  const patch = { ...cfg };
  if (next === undefined) delete patch.workflowSizeGuideline;
  else patch.workflowSizeGuideline = next;
  return patch;
}

export function toggledBoolConfig(
  cfg: UserConfig,
  id: string | undefined,
  state: Readonly<BrokerState>,
  direction: number,
): { cfg: UserConfig; effect?: BoolToggleEffect } | null {
  if (id === "fastMode") {
    const enabled = !state.fastMode;
    return {
      cfg: {
        ...cfg,
        fastModeByProvider: { ...(cfg.fastModeByProvider ?? {}), [state.provider]: enabled },
      },
      effect: { kind: "fastMode", enabled },
    };
  }
  if (id === "autoCompact") {
    return { cfg: { ...cfg, autoCompact: !(cfg.autoCompact ?? true) } };
  }
  if (id === "showTips") {
    return { cfg: { ...cfg, showTips: !(cfg.showTips ?? true) } };
  }
  if (id === "showThinkingSummaries") {
    return { cfg: { ...cfg, showThinkingSummaries: !(cfg.showThinkingSummaries ?? true) } };
  }
  if (id === "verbose") {
    const verbose = !(cfg.verbose ?? false);
    // The transcript reads the store live, so the change applies immediately.
    return { cfg: { ...cfg, verbose }, effect: { kind: "verbose", verbose } };
  }
  if (id === "parallelTasks") {
    return { cfg: { ...cfg, parallelTasks: !(cfg.parallelTasks ?? false) } };
  }
  if (id === "enableWorkflows") {
    return { cfg: { ...cfg, enableWorkflows: !(cfg.enableWorkflows ?? true) } };
  }
  if (id === "workflowKeywordTrigger") {
    return { cfg: { ...cfg, workflowKeywordTrigger: !(cfg.workflowKeywordTrigger ?? true) } };
  }
  if (id === "multiprovider") {
    const next = cycleOrchestrationMode(state.orchestrationMode, direction || 1);
    return {
      cfg: { ...cfg, orchestrationMode: next },
      effect: { kind: "orchestrationMode", mode: next },
    };
  }
  if (id === "quotaFallback") {
    return { cfg: { ...cfg, quotaFallback: !(cfg.quotaFallback ?? true) } };
  }
  if (id === "chainOfCommand") {
    return { cfg: { ...cfg, chainOfCommand: !(cfg.chainOfCommand ?? true) } };
  }
  if (id === "multiModelFork") {
    return { cfg: { ...cfg, multiModelFork: !(cfg.multiModelFork ?? false) } };
  }
  if (id === "editorMode") {
    const current = cfg.editorMode ?? DEFAULT_EDITOR_MODE;
    return { cfg: { ...cfg, editorMode: current === "vim" ? "normal" : "vim" } };
  }
  return null;
}
