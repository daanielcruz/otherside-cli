import { type MutableRefObject, useEffect, useRef } from "react";
import type { ValidationIntent } from "@/engine/contract/login.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  apiKeyProviderFor,
  buildProviderRows,
  type FlowHandle,
  type Phase,
  startOAuthPkce,
  startOAuthRedirect,
} from "@/ui/panels/login/flow";

export function useAutoStart(deps: {
  initialProvider: ProviderId | undefined;
  setPhase: (p: Phase) => void;
  flowRef: MutableRefObject<FlowHandle | null>;
  validationResolveRef: MutableRefObject<((i: ValidationIntent) => void) | null>;
  beginOpenAiCustomConfig: () => void;
  broker: Broker | undefined;
  config: UserConfig | undefined;
  onConfigChange: ((c: UserConfig) => void) | undefined;
}): void {
  const {
    initialProvider,
    setPhase,
    flowRef,
    validationResolveRef,
    beginOpenAiCustomConfig,
    broker,
    config,
    onConfigChange,
  } = deps;
  const autoTriggeredRef = useRef<ProviderId | null>(null);
  useEffect(() => {
    if (!initialProvider) return;
    if (autoTriggeredRef.current === initialProvider) return;
    autoTriggeredRef.current = initialProvider;
    if (initialProvider === "openai-custom") {
      beginOpenAiCustomConfig();
      return;
    }
    const row = buildProviderRows(null).find((r) => r.id === initialProvider);
    if (!row) return;
    const flow = getProviderConfig(initialProvider)?.beginLogin;
    if (!flow) return;
    if (flow.kind === "api_key") {
      const apiProvider = apiKeyProviderFor(initialProvider);
      if (apiProvider) {
        setPhase({
          kind: "api_key",
          provider: apiProvider,
          apiKey: "",
          status: "input",
          message: "",
        });
      }
      return;
    }
    if (flow.kind === "oauth_pkce") {
      startOAuthPkce({
        provider: row,
        begin: flow.begin,
        finalizeLogin: flow.finalizeLogin,
        setPhase,
        flowRef,
        validationResolveRef,
        broker,
        config,
        onConfigChange,
      });
      return;
    }
    if (flow.kind === "oauth_redirect_only") {
      startOAuthRedirect(row, flow.login, setPhase, broker, config, onConfigChange);
    }
  }, [initialProvider]);
}
