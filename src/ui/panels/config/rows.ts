import { type ReactNode } from "react";
import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import { effortLevelsForModel, modelDisplayWithContext } from "@/engine/model/catalog.ts";
import {
  autoRoutesNonVision,
  canSendNatively,
  resolveParserModel,
} from "@/engine/model/facts/capabilities-runtime.ts";
import { imageGeneratorLabel } from "@/engine/providers/image-generation.ts";
import { voiceProviderLabel } from "@/engine/voice/index.ts";
import { type Color as InkColor } from "@/ink";
import {
  effectiveOrchestrationMode,
  normalizeWorkflowSizeGuideline,
  type UserConfig,
  WORKFLOW_SIZE_GUIDELINES,
  type WorkflowSizeGuideline,
} from "@/kernel/config/config.ts";
import {
  ORCHESTRATION_MODE_VALUES,
  type OrchestrationMode,
  orchestrationModeLabel,
} from "@/kernel/config/orchestration-mode.ts";
import {
  isImageGeneratorProviderId,
  isVoiceProviderId,
  type ProviderId,
} from "@/kernel/config/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import {
  type CodexTokens,
  type CredentialsBundle,
  hasCredential,
  type OpenAiCustomCreds,
} from "@/kernel/storage/credentials.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { Color } from "@/ui/theme/theme.ts";

export type TabId = "details" | "config";

export type RowKind =
  | "provider"
  | "model"
  | "modelPanel"
  | "permission"
  | "bool"
  | "language"
  | "imageGeneratorProvider"
  | "voiceProvider"
  | "imageParserProvider"
  | "imageParserModel"
  | "workflowSizeGuideline"
  | "readonly";

export interface SettingsRow {
  label: string;
  labelSuffix?: ReactNode | undefined;
  labelSuffixWidth?: number | undefined;
  value?: string | undefined;
  description?: string | undefined;
  kind: RowKind;
  id?: string | undefined;
  active?: boolean | undefined;
  muted?: boolean | undefined;
  valueColor?: InkColor | undefined;
}

export interface ProviderCredentialDisplay {
  value: string;
  muted?: boolean | undefined;
  valueColor?: InkColor | undefined;
}

export function configPatch(previous: UserConfig, next: UserConfig): Partial<UserConfig> {
  const patch: Partial<UserConfig> = {};
  const keys = new Set<keyof UserConfig>([
    ...(Object.keys(previous) as (keyof UserConfig)[]),
    ...(Object.keys(next) as (keyof UserConfig)[]),
  ]);
  for (const key of keys) {
    if (JSON.stringify(next[key]) !== JSON.stringify(previous[key]))
      patch[key] = next[key] as never;
  }
  return patch;
}

export function applyConfigPatch(current: UserConfig, patch: Partial<UserConfig>): void {
  for (const key of Object.keys(patch) as (keyof UserConfig)[]) {
    const value = patch[key];
    if (value === undefined) delete current[key];
    else current[key] = value as never;
  }
}

export function rowsFor(args: {
  tab: TabId;
  state: Readonly<BrokerState>;
  cfg: UserConfig;
  version: string;
  credentials: CredentialsBundle | null;
}): SettingsRow[] {
  const { tab, state, cfg, version, credentials } = args;
  if (tab === "details") return detailsRows(state, version, credentials);
  return configRows(state, cfg, credentials);
}

export function detailsRows(
  state: Readonly<BrokerState>,
  version: string,
  credentials: CredentialsBundle | null,
): SettingsRow[] {
  const rows = [
    row("Version", version, "readonly"),
    row("cwd", process.cwd(), "readonly"),
    blank(),
    row("Model", modelDisplayWithContext(state.model), "readonly"),
    row("Permission mode", permissionLabel(state), "readonly"),
  ];
  if (effortLevelsForModel(state.model, state.provider).length > 0) {
    const effortLabel = state.effort ?? "default";
    rows.push(row("Effort", effortLabel, "readonly", { valueColor: effortColor(effortLabel) }));
  }
  rows.push(
    blank(),
    row("Providers", undefined, "readonly", { muted: true }),
    ...sortProvidersByAuthKind(listProviderConfigs().map((c) => c.provider.id)).map((provider) => {
      const display = providerCredentialDisplay(provider, credentials);
      const active = provider === state.provider;
      const value = provider === state.provider ? `active · ${display.value}` : display.value;
      return row(getProviderConfig(provider)?.provider.label ?? provider, value, "readonly", {
        muted: display.muted,
        valueColor: active ? Color.success : undefined,
      });
    }),
  );
  return rows;
}

function imageGeneratorDisplay(
  cfg: UserConfig,
  turnProvider: ProviderId,
  credentials: CredentialsBundle | null,
): string {
  const selection = cfg.imageGenProvider;
  if (!selection || selection === "off") {
    if (!selection && isImageGeneratorProviderId(turnProvider)) {
      const suffix = hasCredential(credentials, turnProvider) ? "" : " · not configured";
      return `${imageGeneratorLabel(turnProvider)} · native default${suffix}`;
    }
    return "Off";
  }
  const suffix = hasCredential(credentials, selection) ? "" : " · not configured";
  return `${imageGeneratorLabel(selection)}${suffix}`;
}

function voiceProviderDisplay(
  cfg: UserConfig,
  turnProvider: ProviderId,
  credentials: CredentialsBundle | null,
): string {
  const selection = cfg.voiceProvider;
  if (!selection || selection === "off") {
    if (!selection && isVoiceProviderId(turnProvider)) {
      const suffix = hasCredential(credentials, turnProvider) ? "" : " · not configured";
      return `${voiceProviderLabel(turnProvider)} · native default${suffix}`;
    }
    return "Off";
  }
  const suffix = hasCredential(credentials, selection) ? "" : " · not configured";
  return `${voiceProviderLabel(selection)}${suffix}`;
}

export function configRows(
  state: Readonly<BrokerState>,
  cfg: UserConfig,
  credentials: CredentialsBundle | null,
): SettingsRow[] {
  const orchestrationMode = effectiveOrchestrationMode(cfg);
  const rows: SettingsRow[] = [
    row(
      "Provider",
      getProviderConfig(state.provider)?.provider.label ?? state.provider,
      "provider",
    ),
    row("Model", modelDisplayWithContext(state.model), "model"),
    row("Default permission mode", permissionLabel(state), "permission"),
  ];
  if (!canSendNatively(state.provider, state.model) && !autoRoutesNonVision(state.provider)) {
    const parser = cfg.imageParserProvider;
    const parserLabel = parser ? (getProviderConfig(parser)?.provider.label ?? parser) : "off";
    rows.push(row("Image parser provider", parserLabel, "imageParserProvider"));
    if (parser) {
      const modelId = cfg.imageParserModel ?? resolveParserModel(parser);
      rows.push(row("Image parser model", modelDisplayWithContext(modelId), "imageParserModel"));
    }
  }
  rows.push(
    row(
      "Image generator",
      imageGeneratorDisplay(cfg, state.provider, credentials),
      "imageGeneratorProvider",
      {
        id: "imageGenProvider",
      },
    ),
  );
  rows.push(
    row("Voice provider", voiceProviderDisplay(cfg, state.provider, credentials), "voiceProvider", {
      id: "voiceProvider",
    }),
  );
  rows.push(row("More...", undefined, "modelPanel", { id: "modelPanel" }));
  rows.push(
    blank(),
    row("Auto-compact", boolText(cfg.autoCompact ?? true), "bool", {
      id: "autoCompact",
    }),
    row("Show tips", boolText(cfg.showTips ?? true), "bool", {
      id: "showTips",
    }),
  );
  rows.push(
    row("Encourage parallel tasks", (cfg.parallelTasks ?? false) ? "enabled" : "disabled", "bool", {
      id: "parallelTasks",
    }),
    row("Workflows", (cfg.enableWorkflows ?? true) ? "enabled" : "disabled", "bool", {
      id: "enableWorkflows",
    }),
    row(
      "Workflow size guideline",
      normalizeWorkflowSizeGuideline(cfg.workflowSizeGuideline),
      "workflowSizeGuideline",
      {
        id: "workflowSizeGuideline",
        description: workflowSizeGuidelineDescription(cfg.workflowSizeGuideline),
      },
    ),
    row("Orchestration", orchestrationModeLabel(orchestrationMode), "bool", {
      id: "multiprovider",
      description: orchestrationDescription(orchestrationMode),
    }),
  );
  if (orchestrationMode === "feudalism") {
    rows.push(
      row("Quota fallback", (cfg.quotaFallback ?? true) ? "enabled" : "disabled", "bool", {
        id: "quotaFallback",
        description:
          (cfg.quotaFallback ?? true)
            ? "Uses another provider when the preferred provider hits its quota."
            : "Stops when the preferred provider hits its quota.",
      }),
      row("Chain of command", (cfg.chainOfCommand ?? true) ? "enabled" : "disabled", "bool", {
        id: "chainOfCommand",
        description:
          (cfg.chainOfCommand ?? true)
            ? "Nested agents cannot launch above their own tier."
            : "Nested agents may request any tier.",
      }),
    );
  }
  rows.push(
    row("Output style", cfg.outputStyle ?? "default", "readonly"),
    row("Language", cfg.language?.trim() || "Default (English)", "language"),
  );
  if (getProviderConfig(state.provider)?.featureFlags?.fastMode) {
    rows.push(
      row("Fast mode", boolText(state.fastMode), "bool", {
        id: "fastMode",
      }),
    );
  }
  return rows;
}

export function filterRows(rows: SettingsRow[], query: string): SettingsRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    if (row.label.length === 0) return false;
    return `${row.label} ${row.value ?? ""} ${row.id ?? ""}`.toLowerCase().includes(q);
  });
}

export function keyedRows(
  rows: SettingsRow[],
): { row: SettingsRow; position: number; key: string }[] {
  const seen = new Map<string, number>();
  const keyed: { row: SettingsRow; position: number; key: string }[] = [];
  for (const row of rows) {
    const stem = `${row.id ?? row.label}:${row.value ?? ""}:${row.kind}`;
    const count = seen.get(stem) ?? 0;
    seen.set(stem, count + 1);
    keyed.push({ row, position: keyed.length, key: `${stem}:${count}` });
  }
  return keyed;
}

export function row(
  label: string,
  value: string | undefined,
  kind: RowKind,
  extra: Partial<SettingsRow> = {},
): SettingsRow {
  return { label, value, kind, ...extra };
}

export function blank(): SettingsRow {
  return { label: "", kind: "readonly" };
}

export function cycle<T extends string>(items: readonly T[], current: T, direction: number): T {
  if (items.length === 0) return current;
  const idx = Math.max(0, items.indexOf(current));
  return items[wrapIndex(idx + direction, items.length)] ?? current;
}

export function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export const WORKFLOW_SIZE_GUIDELINE_OPTIONS: readonly WorkflowSizeGuideline[] =
  WORKFLOW_SIZE_GUIDELINES;

export function workflowSizeGuidelineDescription(value: unknown): string {
  switch (normalizeWorkflowSizeGuideline(value)) {
    case "small":
      return "Advisory target: keep workflows under 5 agents.";
    case "medium":
      return "Advisory target: keep workflows under 15 agents.";
    case "large":
      return "Advisory target: keep workflows under 50 agents.";
    default:
      return "No advisory workflow-size target.";
  }
}

export function boolText(value: boolean): string {
  return value ? "true" : "false";
}

export function orchestrationDescription(mode: OrchestrationMode): string {
  switch (mode) {
    case "disabled":
      return "Agents use models from the current provider only.";
    case "default":
      return "Agents can select any available provider and model.";
    case "feudalism":
      return "Routes each delegated task through the emperor, shogun, daimyo, or samurai tier roster.";
  }
}

export function cycleOrchestrationMode(
  current: OrchestrationMode,
  direction: number,
): OrchestrationMode {
  return cycle(ORCHESTRATION_MODE_VALUES, current, direction || 1);
}

export const PERMISSION_MODE_SHORT_TITLE: Record<PermissionMode, string> = {
  default: "Default",
  "accept-edits": "Accept",
  plan: "Plan",
  yolo: "Bypass",
};

export function permissionLabel(state: Readonly<BrokerState>): string {
  return PERMISSION_MODE_SHORT_TITLE[state.permissionMode];
}

export function effortColor(value: string): InkColor {
  if (value === "medium") return Color.success;
  if (value === "high") return Color.primary;
  if (value === "xhigh") return Color.primaryGlow;
  if (value === "max") return Color.error;
  if (value === "low") return Color.text;
  return Color.muted;
}

export const PROVIDER_AUTH_RANK: Record<ProviderId, number> = {
  anthropic: 0,
  antigravity: 0,
  codex: 0,
  xai: 0,
  deepseek: 1,
  kimi: 1,
  minimax: 1,
  glm: 1,
  openai: 2,
};

export function sortProvidersByAuthKind(ids: readonly ProviderId[]): ProviderId[] {
  return [...ids].sort((a, b) => {
    const ra = PROVIDER_AUTH_RANK[a] ?? 99;
    const rb = PROVIDER_AUTH_RANK[b] ?? 99;
    if (ra !== rb) return ra - rb;
    const aLabel = getProviderConfig(a)?.provider.label ?? a;
    const bLabel = getProviderConfig(b)?.provider.label ?? b;
    return aLabel.localeCompare(bLabel);
  });
}

export function providerCredentialDisplay(
  provider: ProviderId,
  credentials: CredentialsBundle | null,
): ProviderCredentialDisplay {
  if (credentials === null) return { value: "checking", muted: true };
  if (provider === "anthropic") {
    const email = credentials.anthropic?.accountEmail;
    return email
      ? { value: maskEmail(email), valueColor: Color.success }
      : { value: "not logged in", muted: true };
  }
  if (provider === "codex") {
    const tokens = credentials.codex;
    if (!tokens) return { value: "not logged in", muted: true };
    const email = codexEmail(tokens);
    if (email) return { value: maskEmail(email), valueColor: Color.success };
    if (tokens.accountId) {
      return {
        value: `account ${maskSecret(tokens.accountId)}`,
        valueColor: Color.success,
      };
    }
    return { value: "email unavailable", valueColor: Color.success };
  }
  if (provider === "xai") {
    const tokens = credentials.xai;
    if (!tokens) return { value: "not logged in", muted: true };
    const email = tokens.idToken
      ? (decodeJwtPayload(tokens.idToken)?.email as string | undefined)
      : undefined;
    if (email) return { value: maskEmail(email), valueColor: Color.success };
    if (tokens.accountId) {
      return { value: `account ${maskSecret(tokens.accountId)}`, valueColor: Color.success };
    }
    return { value: "signed in", valueColor: Color.success };
  }
  if (provider === "antigravity") {
    const email = credentials.antigravity?.email;
    return email
      ? { value: maskEmail(email), valueColor: Color.success }
      : { value: "not logged in", muted: true };
  }
  if (provider === "kimi") {
    const apiKey = credentials.kimi?.apiKey;
    return apiKey
      ? { value: `API key ${maskSecret(apiKey)}`, valueColor: Color.success }
      : { value: "not configured", muted: true };
  }
  if (provider === "deepseek") {
    const apiKey = credentials.deepseek?.apiKey;
    return apiKey
      ? { value: `API key ${maskSecret(apiKey)}`, valueColor: Color.success }
      : { value: "not configured", muted: true };
  }
  if (provider === "minimax") {
    const apiKey = credentials.minimax?.apiKey;
    return apiKey
      ? { value: `API key ${maskSecret(apiKey)}`, valueColor: Color.success }
      : { value: "not configured", muted: true };
  }
  if (provider === "glm") {
    const apiKey = credentials.glm?.apiKey;
    return apiKey
      ? { value: `API key ${maskSecret(apiKey)}`, valueColor: Color.success }
      : { value: "not configured", muted: true };
  }
  if (provider === "openai") {
    const custom = credentials.openai as (OpenAiCustomCreds & { model?: string }) | undefined;
    if (!custom?.baseUrl) return { value: "not configured", muted: true };
    const keyLabel = custom.apiKey ? `API key ${maskSecret(custom.apiKey)}` : "no API key";
    const modelSuffix = custom.model ? ` · ${custom.model}` : "";
    const contextSuffix = custom.contextWindow
      ? ` · ${formatContextWindow(custom.contextWindow)}`
      : "";
    const outputSuffix = custom.outputTokenLimit
      ? ` · ${formatTokens(custom.outputTokenLimit)}`
      : "";
    return {
      value: `${keyLabel} · ${custom.baseUrl}${modelSuffix}${contextSuffix}${outputSuffix}`,
      valueColor: Color.success,
    };
  }
  return { value: "not configured", muted: true };
}

export const formatContextWindow = (value: number): string => {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M context`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K context`;
  return `${value} context`;
};

export function formatTokens(value: number): string {
  if (value >= 1_000) return `${Math.round(value / 1_000)}K max output`;
  return `${value} max output`;
}

export function codexEmail(tokens: CodexTokens): string | null {
  if (!tokens.idToken) return null;
  const payload = decodeJwtPayload(tokens.idToken);
  const email = payload?.email;
  return typeof email === "string" ? email : null;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const segment = parts[1];
  if (!segment) return null;
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  try {
    return JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return maskSecret(email);
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  const stars = "*".repeat(Math.max(1, Math.min(4, local.length - head.length)));
  return `${head}${stars}@${domain}`;
}

export function maskSecret(value: string): string {
  if (value.length === 0) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}
