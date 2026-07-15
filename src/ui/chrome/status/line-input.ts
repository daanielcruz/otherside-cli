import { spawn } from "node:child_process";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { findModel } from "@/engine/model/catalog.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { shellCommand } from "@/kernel/std/proc/shell.ts";
import { capitalize } from "@/kernel/std/text/text.ts";
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
}: BuildStatuslineInputArgs): StatuslineInput {
  const model = findModel(state.model, state.provider);
  const contextWindowSize = model?.contextWindow ?? 200_000;
  const totalInput = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const contextUsed = totalInput + outputTokens;
  const usedPercentage =
    contextWindowSize > 0 ? Math.min(100, Math.round((contextUsed / contextWindowSize) * 100)) : 0;
  const baseName = model?.displayName ?? state.model;
  const kimiSuffix = state.provider === "kimi-code" ? `${baseName} Thinking` : baseName;
  const displayName = displayModelName(state, kimiSuffix);
  return {
    session_id: sessionId,
    cwd,
    provider: {
      id: state.provider,
      display_name: getProviderConfig(state.provider)?.provider.label ?? state.provider,
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
      name: "default",
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

export function effortStatuslineSuffix(
  state: Pick<BrokerState, "provider" | "effort">,
): string | null {
  if (!getProviderConfig(state.provider)?.featureFlags?.effortSuffix) return null;
  if (state.effort === null) return null;
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

export function runStatuslineCommand(
  command: string,
  input: StatuslineInput,
  timeoutMs = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const argv = shellCommand(command, { login: true });
    const [head, ...rest] = argv;
    if (!head) {
      resolve(null);
      return;
    }
    const child = spawn(head, rest, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(normalizeCommandOutput(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function normalizeCommandOutput(stdout: string): string | null {
  const text = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text.length > 0 ? text : null;
}

function formatTokens(tokens: number, _window: number): string {
  return `${Math.floor(tokens / 1000)}K`;
}
