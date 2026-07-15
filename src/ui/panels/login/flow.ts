import type {
  FinalizeLoginResult,
  OAuthHandle,
  ValidationHandler,
  ValidationIntent,
} from "@/engine/contract/login.ts";
import {
  getProviderConfig,
  listProviderConfigs,
  providerSortRank,
} from "@/engine/contract/registry.ts";
import { registerRuntimeModel } from "@/engine/model/catalog.ts";
import type { OpenAiCustomModelInfo } from "@/engine/providers/openai/models.ts";
import { fastModeForProvider, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import {
  type CredentialsBundle,
  hasCredential,
  type OpenAiCustomCreds,
  type ProviderSlug,
  saveFor,
} from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { Color, type ColorValue, Glyph } from "@/ui/theme/theme.ts";

export interface ProviderRow {
  id:
    | "anthropic"
    | "codex"
    | "xai"
    | "kimi-code"
    | "deepseek"
    | "minimax"
    | "glm"
    | "antigravity"
    | "openai-custom";
  label: string;
  hint: string;
  signedIn: boolean;
}

const PICKER_LABELS: Record<string, string> = {
  anthropic: "Anthropic - OAuth",
  antigravity: "Antigravity - OAuth",
  codex: "Codex - OAuth",
  deepseek: "DeepSeek - API Key",
  glm: "Z.AI - OAuth",
  xai: "xAI - OAuth",
  "kimi-code": "Kimi Code - API Key",
  minimax: "MiniMax - API Key",
  "openai-custom": "OpenAI Custom - API Key",
};

export function buildProviderRows(bundle: CredentialsBundle | null): ProviderRow[] {
  return listProviderConfigs()
    .sort((a, b) => providerSortRank(a.provider.id) - providerSortRank(b.provider.id))
    .map((c) => ({
      id: c.provider.id as ProviderRow["id"],
      label: PICKER_LABELS[c.provider.id] ?? c.provider.label,
      hint: c.signupHint ?? "",
      signedIn: hasCredential(bundle, c.provider.id as ProviderSlug),
    }));
}

export type ApiKeyLoginProvider = "kimi-code" | "deepseek" | "minimax";

export function apiKeyProviderFor(id: ProviderRow["id"]): ApiKeyLoginProvider | null {
  if (id === "deepseek") return "deepseek";
  if (id === "minimax") return "minimax";
  if (id === "kimi-code") return "kimi-code";
  return null;
}

export type OAuthStatus = "running" | "ok" | "fail";

export type Phase =
  | { kind: "list" }
  | {
      kind: "oauth";
      provider: ProviderRow;
      url: string;
      pasted: string;
      status: OAuthStatus;
      message: string;
      supportsPaste: boolean;
    }
  | {
      kind: "verify";
      provider: ProviderRow;
      url: string;
      description: string;
      status: "waiting" | "checking" | "fail";
      message: string;
    }
  | {
      kind: "api_key";
      provider: ApiKeyLoginProvider;
      apiKey: string;
      status: "input" | "saving" | "fail";
      message: string;
    }
  | {
      kind: "custom";
      step: "credentials";
      field: 0 | 1;
      url: string;
      apiKey: string;
      model: string;
      contextWindow: string;
      outputTokenLimit: string;
      status: "input" | "discovering" | "fail";
      message: string;
    }
  | {
      kind: "custom";
      step: "model";
      url: string;
      apiKey: string;
      model: string;
      contextWindow: string;
      outputTokenLimit: string;
      models: OpenAiCustomModelInfo[];
      cursor: number;
      manual: boolean;
      message: string;
      failedDiscovery: boolean;
    }
  | {
      kind: "custom";
      step: "context";
      url: string;
      apiKey: string;
      model: string;
      contextWindow: string;
      outputTokenLimit: string;
      status: "input" | "fail";
      message: string;
    }
  | {
      kind: "custom";
      step: "output";
      url: string;
      apiKey: string;
      model: string;
      contextWindow: string;
      outputTokenLimit: string;
      status: "input" | "fail";
      message: string;
    }
  | {
      kind: "custom";
      step: "testing" | "saving" | "success";
      url: string;
      apiKey: string;
      model: string;
      contextWindow: string;
      outputTokenLimit: string;
      message: string;
    }
  | {
      kind: "custom";
      step: "test_failed";
      url: string;
      apiKey: string;
      model: string;
      contextWindow: string;
      outputTokenLimit: string;
      message: string;
      cursor: 0 | 1;
    };

export type FlowHandle = OAuthHandle;

export const OPENAI_CUSTOM_URL_PLACEHOLDER = "http://localhost:1234";

export function persistApiKeyCredential(
  provider: ApiKeyLoginProvider,
  apiKey: string,
): Promise<unknown> {
  if (provider === "deepseek") return saveFor("deepseek", { apiKey });
  if (provider === "minimax") return saveFor("minimax", { apiKey });
  return saveFor("kimi-code", { apiKey });
}

export function loginFooterHints(phase: Phase): [string, string][] {
  if (phase.kind === "list") {
    return [
      ["↑↓", "navigate"],
      ["Enter", "sign in"],
      ["Esc", "cancel"],
    ];
  }
  if (phase.kind === "oauth" && phase.status === "ok") {
    return [
      ["Enter", "continue"],
      ["Esc", "close"],
    ];
  }
  if (phase.kind === "oauth" && phase.status === "running" && phase.supportsPaste) {
    return [
      ["Enter", "submit pasted code"],
      ["Esc", "back"],
    ];
  }
  if (phase.kind === "api_key") {
    return [
      ["Enter", "save"],
      ["Esc", "back"],
    ];
  }
  if (phase.kind === "custom") return customFooterHints(phase);
  return [["Esc", "close"]];
}

export function oauthStatusColor(status: OAuthStatus): ColorValue {
  if (status === "ok") return Color.success;
  if (status === "fail") return Color.error;
  return Color.highlight;
}

export const API_KEY_HOST_LABELS: Record<ApiKeyLoginProvider, string> = {
  deepseek: "DeepSeek (API Key)",
  minimax: "MiniMax (API Key)",
  "kimi-code": "Kimi Code (API Key)",
};

export function customFooterHints(phase: Extract<Phase, { kind: "custom" }>): [string, string][] {
  if (phase.step === "credentials") {
    return [
      ["Tab/↓", "next"],
      ["↑", "prev"],
      ["Enter", phase.field === 0 ? "next" : "fetch models"],
      ["Esc", "back"],
    ];
  }
  if (phase.step === "model") {
    return phase.manual
      ? [
          ["Enter", "test"],
          ["Tab", "model list"],
          ["Esc", "back"],
        ]
      : [
          ["↑↓", "select"],
          ["m", "manual"],
          ["Enter", "test"],
          ["Esc", "back"],
        ];
  }
  if (phase.step === "context") {
    return [
      ["Enter", "next"],
      ["Esc", "back"],
    ];
  }
  if (phase.step === "output") {
    return [
      ["Enter", "test"],
      ["Esc", "back"],
    ];
  }
  if (phase.step === "test_failed") {
    return [
      ["↑↓", "choose"],
      ["Enter", "confirm"],
      ["Esc", "back"],
    ];
  }
  return [["Esc", "close"]];
}

export function openAiCustomCredentialsPhase(
  stored: OpenAiCustomCreds | null,
): Extract<Phase, { kind: "custom"; step: "credentials" }> {
  return {
    kind: "custom",
    step: "credentials",
    field: 0,
    url: stored?.baseUrl ?? "",
    apiKey: stored?.apiKey ?? "",
    model: stored?.model ?? "",
    contextWindow: stored?.contextWindow ? String(stored.contextWindow) : "",
    outputTokenLimit: stored?.outputTokenLimit ? String(stored.outputTokenLimit) : "",
    status: "input",
    message: "",
  };
}

export function contextWindowText(value: number | undefined, fallback: string): string {
  return value ? String(value) : fallback;
}

export function contextMessage(contextWindow: string): string {
  return contextWindow.length > 0
    ? "Context window detected. Edit if needed."
    : "Type the max context window in tokens.";
}

export function normalizeContextWindowInput(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function normalizeOutputTokenLimitInput(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function outputTokenLimitText(value: string, contextWindow: string): string {
  if (value.length > 0) return value;
  const context = normalizeContextWindowInput(contextWindow);
  if (!context) return "8192";
  return String(Math.max(1024, Math.min(8192, Math.floor(context / 4))));
}

export function formatContextWindow(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M context`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K context`;
  return `${value} context`;
}

export function formatOutputTokenLimit(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K tokens`;
  return `${value} tokens`;
}

export function inputDisplay(value: string, placeholder: string, focused: boolean): string {
  if (value.length > 0) return `${value}${focused ? Glyph.blockHalf : ""}`;
  return `${placeholder}${focused ? Glyph.blockHalf : ""}`;
}

export function registerOpenAiCustomModel(model: string, contextWindow: number): void {
  registerRuntimeModel({
    id: model,
    displayName: model,
    contextWindow,
    provider: "openai-custom",
    efforts: [],
    defaultEffort: null,
  });
}

export function maskKey(value: string): string {
  if (value.length === 0) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}

export async function activateProviderAfterLogin(
  providerId: ProviderId,
  broker: Broker | undefined,
  config: UserConfig | undefined,
  onConfigChange?: ((config: UserConfig) => void) | undefined,
): Promise<void> {
  if (!broker) return;
  const rawDefault = getProviderConfig(providerId)?.defaultModelId;
  const model = typeof rawDefault === "function" ? rawDefault() : (rawDefault ?? "");
  broker.dispatch({
    kind: "set_provider",
    provider: providerId,
    model,
    ...(config ? { fastMode: fastModeForProvider(config, providerId) } : {}),
  });
  if (config) {
    const next = {
      ...config,
      defaultProvider: providerId,
      defaultModel: model,
    };
    await updateConfig((current) => {
      current.defaultProvider = providerId;
      current.defaultModel = model;
    });
    onConfigChange?.(next);
  }
}

export interface OAuthPkceOptions {
  provider: ProviderRow;
  begin: () => Promise<OAuthHandle>;
  finalizeLogin?:
    | ((opts: { onValidation: ValidationHandler }) => Promise<FinalizeLoginResult>)
    | undefined;
  setPhase: (p: Phase) => void;
  flowRef: { current: FlowHandle | null };
  validationResolveRef: {
    current: ((intent: ValidationIntent) => void) | null;
  };
  broker?: Broker | undefined;
  config?: UserConfig | undefined;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
}

export async function runFinalizeLogin(
  opts: OAuthPkceOptions,
): Promise<"ok" | "change_auth" | "fail"> {
  const { provider, finalizeLogin, setPhase, validationResolveRef } = opts;
  if (!finalizeLogin) return "ok";
  setPhase({
    kind: "oauth",
    provider,
    url: "",
    pasted: "",
    status: "running",
    message: `setting up ${provider.label}…`,
    supportsPaste: false,
  });
  const onValidation: ValidationHandler = (url, description) =>
    new Promise<ValidationIntent>((resolve) => {
      validationResolveRef.current = (intent) => {
        validationResolveRef.current = null;
        resolve(intent);
      };
      setPhase({
        kind: "verify",
        provider,
        url,
        description,
        status: "waiting",
        message: "Verify your account in the browser, then press Enter.",
      });
      void openBrowser(url).catch(() => {});
    });
  try {
    const result = await finalizeLogin({ onValidation });
    return result === "change_auth" ? "change_auth" : "ok";
  } catch (err) {
    setPhase({
      kind: "oauth",
      provider,
      url: "",
      pasted: "",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
      supportsPaste: false,
    });
    return "fail";
  }
}

export function startOAuthPkce(opts: OAuthPkceOptions): void {
  const { provider, begin, setPhase, flowRef, broker, config, onConfigChange } = opts;
  setPhase({
    kind: "oauth",
    provider,
    url: "",
    pasted: "",
    status: "running",
    message: "starting OAuth…",
    supportsPaste: true,
  });
  const failPhase = (url: string, supportsPaste: boolean, err: unknown): void => {
    flowRef.current = null;
    setPhase({
      kind: "oauth",
      provider,
      url,
      pasted: "",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
      supportsPaste,
    });
  };
  void begin()
    .then((flow) => {
      flowRef.current = flow;
      const supportsPaste = typeof flow.submitCode === "function";
      setPhase({
        kind: "oauth",
        provider,
        url: flow.url,
        pasted: "",
        status: "running",
        message: flow.message ?? "browser opened — waiting for redirect…",
        supportsPaste,
      });
      void openBrowser(flow.url).catch(() => {});
      flow.result
        .then(async () => {
          flowRef.current = null;
          const outcome = await runFinalizeLogin(opts);
          if (outcome === "change_auth") {
            startOAuthPkce(opts);
            return;
          }
          if (outcome === "fail") return;
          setPhase({
            kind: "oauth",
            provider,
            url: flow.url,
            pasted: "",
            status: "ok",
            message: `Signed in to ${provider.label}.`,
            supportsPaste,
          });
          await activateProviderAfterLogin(
            provider.id as ProviderId,
            broker,
            config,
            onConfigChange,
          );
        })
        .catch((err) => failPhase(flow.url, supportsPaste, err));
    })
    // begin() itself can reject before a flow exists (e.g. xai's device-code
    // request fails offline); without this the rejection is unhandled and the
    // panel stays stuck on "starting OAuth…".
    .catch((err) => failPhase("", true, err));
}

export function startOAuthRedirect(
  provider: ProviderRow,
  login: () => Promise<unknown>,
  setPhase: (p: Phase) => void,
  broker?: Broker,
  config?: UserConfig,
  onConfigChange?: (config: UserConfig) => void,
): void {
  setPhase({
    kind: "oauth",
    provider,
    url: "",
    pasted: "",
    status: "running",
    message: `opening browser for ${provider.label}…`,
    supportsPaste: false,
  });
  login()
    .then(async () => {
      setPhase({
        kind: "oauth",
        provider,
        url: "",
        pasted: "",
        status: "ok",
        message: `Signed in to ${provider.label}.`,
        supportsPaste: false,
      });
      await activateProviderAfterLogin(provider.id as ProviderId, broker, config, onConfigChange);
    })
    .catch((err) => {
      setPhase({
        kind: "oauth",
        provider,
        url: "",
        pasted: "",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
        supportsPaste: false,
      });
    });
}
