import { getProviderConfig } from "@/engine/contract/registry.ts";
import { effortLevelsForModel, findModel } from "@/engine/model/catalog.ts";
import { DEFAULT_OUTPUT_STYLE } from "@/harness/routines/output-styles/built-in.ts";
import { capitalize } from "@/kernel/std/text/text.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import { type ProviderId, providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";

export interface StatuslineInput {
  session_id: string;
  cwd: string;
  provider: {
    id: ProviderId;
    display_name: string;
  };
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
    added_dirs: string[];
  };
  version: string;
  permission_mode: PermissionMode;
  yolo: boolean;
  output_style: {
    name: string;
  };
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage: null | {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    used_percentage: number;
    remaining_percentage: number;
  };
}

export interface BuildStatuslineInputArgs {
  state: BrokerState;
  sessionId: string;
  version: string;
  cwd: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  costUsd?: number | undefined;
  durationMs?: number | undefined;
  outputStyle?: string | undefined;
}

export function buildStatuslineInput({
  state,
  sessionId,
  version,
  cwd,
  inputTokens = 0,
  outputTokens = 0,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  costUsd = 0,
  durationMs = 0,
  outputStyle = DEFAULT_OUTPUT_STYLE,
}: BuildStatuslineInputArgs): StatuslineInput {
  const model = findModel({ provider: state.provider, model: state.model });
  const contextWindowSize = model?.contextWindow ?? 200_000;
  const totalInput = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const contextUsed = totalInput + outputTokens;
  const usedPercentage =
    contextWindowSize > 0 ? Math.min(100, Math.round((contextUsed / contextWindowSize) * 100)) : 0;
  const baseName = model?.displayName ?? state.model;
  const kimiSuffix = state.provider === "kimi" ? `${baseName} Thinking` : baseName;
  const displayName = displayModelName(state, kimiSuffix);
  return {
    session_id: sessionId,
    cwd,
    provider: {
      id: state.provider,
      display_name: providerDisplayName(state.provider),
    },
    model: {
      id: state.model,
      display_name: displayName,
    },
    workspace: {
      current_dir: cwd,
      project_dir: cwd,
      added_dirs: [],
    },
    version,
    permission_mode: state.permissionMode,
    yolo: state.permissionMode === "yolo",
    output_style: {
      name: outputStyle,
    },
    cost: {
      total_cost_usd: costUsd,
      total_duration_ms: durationMs,
      total_api_duration_ms: durationMs,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    context_window: {
      total_input_tokens: totalInput,
      total_output_tokens: outputTokens,
      context_window_size: contextWindowSize,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
      },
      used_percentage: usedPercentage,
      remaining_percentage: Math.max(0, 100 - usedPercentage),
    },
  };
}

export function renderNativeStatusline(input: StatuslineInput): string {
  const used = input.context_window.total_input_tokens + input.context_window.total_output_tokens;
  const available = Math.max(0, input.context_window.context_window_size - used);
  return [
    `[${input.provider.display_name}] ${input.model.display_name}`,
    `${formatTokens(available, input.context_window.context_window_size)} available`,
    `${input.context_window.used_percentage}% used`,
  ].join(" · ");
}

// Transient notice shown for a few seconds at session start and whenever the
// orchestration mode changes; it never renders as a permanent label.
function orchestrationNoticeText(
  mode: OrchestrationMode,
  kind: "startup" | "switch",
): string | null {
  if (kind === "startup") {
    if (mode === "disabled") return null;
    return `Multiprovider orchestration is active in ${mode} mode`;
  }
  if (mode === "disabled") return "Multiprovider orchestration disabled";
  return `Multiprovider orchestration set to ${mode} mode`;
}

// Session-scoped dedup: the notice fires on the first observation of the
// session (startup) and on a real mode change (switch) — never again for the
// same mode, no matter how often the consuming component remounts.
let observedOrchestrationMode: OrchestrationMode | null = null;

export function nextOrchestrationNotice(mode: OrchestrationMode): string | null {
  if (observedOrchestrationMode === mode) return null;
  const kind = observedOrchestrationMode === null ? "startup" : "switch";
  observedOrchestrationMode = mode;
  return orchestrationNoticeText(mode, kind);
}

/** Clears the session dedup so the next observation counts as startup. */
export function resetOrchestrationNoticeState(): void {
  observedOrchestrationMode = null;
}

/**
 * The effort the active model is running at, named for the reader. The model decides
 * whether there is one to name: a provider is the wrong unit, because a provider can
 * offer a model that reasons at a chosen level beside one that has no levels at all.
 */
export function effortStatuslineSuffix(
  state: Pick<BrokerState, "provider" | "model" | "effort">,
): string | null {
  if (state.effort === null) return null;
  if (effortLevelsForModel({ provider: state.provider, model: state.model }).length === 0) {
    return null;
  }
  if (state.effort === "xhigh") return "xHigh";
  if (state.effort === "max") return "Max";
  return capitalize(state.effort);
}

export function fastModeStatuslineSuffix(
  state: Pick<BrokerState, "provider" | "fastMode">,
): string | null {
  if (!getProviderConfig(state.provider)?.featureFlags?.fastMode) return null;
  return state.fastMode ? "Fast" : null;
}

function displayModelName(state: BrokerState, base: string): string {
  const suffixes = [fastModeStatuslineSuffix(state)].filter((v): v is string => v !== null);
  return suffixes.length === 0 ? base : `${base} ${suffixes.join(" ")}`;
}

function formatTokens(tokens: number, _window: number): string {
  return `${Math.floor(tokens / 1000)}K`;
}
