import { useEffect, useMemo, useRef, useState } from "react";
import type { ValidationIntent } from "@/engine/contract/login.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { type CredentialsBundle, loadAll } from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { createOpenAiCustomActions } from "@/ui/panels/login/actions";
import {
  buildProviderRows,
  type FlowHandle,
  loginFooterHints,
  openAiCustomCredentialsPhase,
  type Phase,
} from "@/ui/panels/login/flow";
import {
  activateProvider,
  handleLoginCancel,
  handlePanelKey,
  type KeymapContext,
} from "@/ui/panels/login/keymap";
import { useAutoStart } from "@/ui/panels/login/use-auto-start";
import { useLoginFields } from "@/ui/panels/login/use-fields";
import {
  ApiKeyForm,
  CustomForm,
  OAuthPhase,
  ProviderList,
  VerifyPhase,
} from "@/ui/panels/login/views";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";

export interface LoginOverlayProps {
  onClose?: () => void;
  initialProvider?: ProviderId | undefined;
  broker?: Broker | undefined;
  config?: UserConfig | undefined;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
}

export function LoginOverlay({
  onClose,
  initialProvider,
  broker,
  config,
  onConfigChange,
}: LoginOverlayProps = {}): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>(() =>
    initialProvider === "openai" ? openAiCustomCredentialsPhase(null) : { kind: "list" },
  );
  const [bundle, setBundle] = useState<CredentialsBundle | null>(null);
  const flowRef = useRef<FlowHandle | null>(null);
  const validationResolveRef = useRef<((intent: ValidationIntent) => void) | null>(null);
  const rows = buildProviderRows(bundle);

  useEffect(() => {
    void loadAll().then(setBundle);
  }, [phase.kind]);

  const actions = useMemo(
    () => createOpenAiCustomActions({ setPhase, close, broker, config, onConfigChange }),
    [close, broker, config, onConfigChange],
  );

  useAutoStart({
    initialProvider,
    setPhase,
    flowRef,
    validationResolveRef,
    beginOpenAiCustomConfig: actions.beginOpenAiCustomConfig,
    broker,
    config,
    onConfigChange,
  });

  const hasAnyCredential =
    bundle !== null &&
    Object.values(bundle as Record<string, unknown>).some((value) => value !== undefined);
  const tryClose = (): void => {
    if (hasAnyCredential) {
      close();
    }
  };

  const fields = useLoginFields(phase, setPhase);

  const ctx: KeymapContext = {
    phase,
    setPhase,
    cursor,
    setCursor,
    rows,
    close,
    tryClose,
    initialProvider,
    flowRef,
    validationResolveRef,
    fields,
    actions,
    broker,
    config,
    onConfigChange,
  };

  usePanelNavigation({
    onClose: tryClose,
    skipEsc: true,
    rows:
      phase.kind === "list"
        ? {
            count: rows.length,
            selected: cursor,
            onChange: setCursor,
          }
        : undefined,
    onActivate: () => {
      if (phase.kind === "list") activateProvider(ctx);
    },
    onBack: () => {
      handleLoginCancel(ctx);
      return true;
    },
    onKey: (input, key) => handlePanelKey(ctx, input, key),
  });

  const footerHints = loginFooterHints(phase);

  const title = phase.kind === "custom" ? "OpenAI Custom" : "Sign in";

  return (
    <FooterPanel title={title} footerHints={footerHints} onCancel={() => handleLoginCancel(ctx)}>
      {phase.kind === "list" && (
        <ProviderList
          cursor={cursor}
          bundle={bundle}
          configured={config?.defaultProvider !== undefined}
        />
      )}
      {phase.kind === "oauth" && <OAuthPhase phase={phase} />}
      {phase.kind === "verify" && <VerifyPhase phase={phase} />}
      {phase.kind === "api_key" && <ApiKeyForm phase={phase} />}
      {phase.kind === "custom" && <CustomForm phase={phase} />}
    </FooterPanel>
  );
}
