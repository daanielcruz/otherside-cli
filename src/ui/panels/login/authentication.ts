import type { ValidationIntent } from "@/engine/contract/login.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { fastModeForProvider, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { OpenAiCustomActions } from "@/ui/panels/login/actions.ts";
import {
  apiKeyProviderFor,
  type FlowHandle,
  type Phase,
  type ProviderRow,
  persistApiKeyCredential,
  startOAuthPkce,
  startOAuthRedirect,
} from "@/ui/panels/login/flow.ts";

export interface LoginAuthenticationDeps {
  actions: OpenAiCustomActions;
  broker: Broker | undefined;
  getConfig: () => UserConfig | undefined;
  setConfig: (config: UserConfig) => void;
  isCancelled: () => boolean;
  setPhase: (phase: Phase) => void;
  close: () => void;
  tryClose: () => void;
  flowRef: { current: FlowHandle | null };
  validationResolveRef: { current: ((intent: ValidationIntent) => void) | null };
  applyText: (field: "oauth-paste" | "api-key", key: KeyEventData) => void;
}

export function startLoginFlow(row: ProviderRow, deps: LoginAuthenticationDeps): void {
  const flow = getProviderConfig(row.id)?.beginLogin;
  if (!flow) return;
  if (flow.kind === "api_key") {
    const provider = apiKeyProviderFor(row.id);
    if (!provider) return;
    deps.setPhase({
      kind: "api_key",
      provider,
      apiKey: "",
      status: "input",
      message: "",
    });
    return;
  }
  if (flow.kind === "openai_custom") {
    deps.actions.beginOpenAiCustomConfig();
    return;
  }
  if (flow.kind === "oauth_pkce") {
    startOAuthPkce({
      provider: row,
      begin: flow.begin,
      finalizeLogin: flow.finalizeLogin,
      setPhase: deps.setPhase,
      flowRef: deps.flowRef,
      validationResolveRef: deps.validationResolveRef,
      broker: deps.broker,
      config: deps.getConfig(),
      onConfigChange: deps.setConfig,
    });
    return;
  }
  startOAuthRedirect(row, flow.login, deps.setPhase, deps.broker, deps.getConfig(), deps.setConfig);
}

export function handleLoginVerificationKey(
  phase: Phase,
  key: KeyEventData,
  deps: LoginAuthenticationDeps,
): void {
  if (phase.kind !== "verify") return;
  if (key.name === "return") {
    deps.setPhase({ ...phase, status: "checking", message: "checking…" });
    deps.validationResolveRef.current?.("verify");
    return;
  }
  if (key.sequence === "a" || key.sequence === "A") {
    deps.validationResolveRef.current?.("change_auth");
    return;
  }
  if (key.name === "left") {
    deps.validationResolveRef.current?.("cancel");
  }
}

export function handleLoginOAuthKey(
  phase: Phase,
  key: KeyEventData,
  deps: LoginAuthenticationDeps,
): void {
  if (phase.kind !== "oauth") return;
  if (phase.status === "ok") {
    if (key.name === "return" || key.name === "left") {
      deps.flowRef.current = null;
      deps.close();
    }
    return;
  }
  if (key.name === "left") {
    deps.flowRef.current = null;
    if (phase.status === "running") deps.setPhase({ kind: "list" });
    else deps.tryClose();
    return;
  }
  if (phase.status !== "running") return;
  if (key.name === "return") {
    const trimmed = phase.pasted.trim();
    if (trimmed.length === 0 || !phase.supportsPaste) return;
    deps.setPhase({
      ...phase,
      pasted: "",
      message: `verifying code for ${phase.provider.label}…`,
      supportsPaste: false,
    });
    deps.flowRef.current?.submitCode?.(trimmed);
    return;
  }
  if (!phase.supportsPaste) return;
  deps.applyText("oauth-paste", key);
}

export function handleLoginApiKeyKey(
  phase: Phase,
  key: KeyEventData,
  deps: LoginAuthenticationDeps,
): void {
  if (phase.kind !== "api_key") return;
  if (key.name === "left") {
    deps.setPhase({ kind: "list" });
    return;
  }
  if (key.name === "return") {
    if (phase.apiKey.trim().length === 0) return;
    const apiKey = phase.apiKey.trim();
    const provider = phase.provider;
    deps.setPhase({ ...phase, status: "saving", message: "" });
    void persistApiKeyCredential(provider, apiKey)
      .then(async () => {
        if (deps.isCancelled()) return;
        const rawDefault = getProviderConfig(provider)?.defaultModelId;
        const model = typeof rawDefault === "function" ? rawDefault() : (rawDefault ?? "");
        const config = deps.getConfig();
        deps.broker?.dispatch({
          kind: "set_route",
          route: { provider, model },
          ...(config ? { fastMode: fastModeForProvider(config, provider) } : {}),
        });
        if (config) {
          const next = {
            ...config,
            defaultProvider: provider,
            defaultModel: model,
          };
          await updateConfig((current) => {
            current.defaultProvider = provider;
            current.defaultModel = model;
          });
          deps.setConfig(next);
        }
        deps.close();
      })
      .catch((err: unknown) => {
        if (deps.isCancelled()) return;
        deps.setPhase({
          kind: "api_key",
          provider,
          apiKey,
          status: "fail",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return;
  }
  if (phase.status !== "input") return;
  deps.applyText("api-key", key);
}
