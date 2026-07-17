import { useEffect, useState } from "react";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { Text, useApp } from "@/ink";
import { deleteFor, type ProviderSlug } from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { useOverlayState } from "@/ui/panels/context";
import { Color } from "@/ui/theme/theme.ts";

export interface LogoutOverlayProps {
  broker?: Broker;
  onClose?: () => void;
}

type Phase = "running" | "done" | "error";

export function LogoutOverlay({ broker, onClose }: LogoutOverlayProps = {}): React.JSX.Element {
  const state = useOverlayState();
  const activeBroker = broker ?? state.broker;
  const { exit } = useApp();
  const provider = activeBroker.read().provider as ProviderSlug;
  const [phase, setPhase] = useState<Phase>("running");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    deleteFor(provider)
      .then(() => {
        if (cancelled) return;
        setPhase("done");
        setTimeout(() => exit(), 200);
      })
      .catch((err) => {
        if (cancelled) return;
        setPhase("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [provider, exit]);

  if (phase === "error") {
    return (
      <FooterPanel onCancel={onClose}>
        <Text color={Color.error}>logout failed: {errorMsg ?? "unknown error"}</Text>
      </FooterPanel>
    );
  }

  if (phase === "done") {
    return (
      <FooterPanel onCancel={onClose}>
        <Text>
          Successfully logged out from your{" "}
          {getProviderConfig(provider)?.provider.label ?? provider} account.
        </Text>
      </FooterPanel>
    );
  }

  return (
    <FooterPanel onCancel={onClose}>
      <Text color={Color.muted}>Logging out…</Text>
    </FooterPanel>
  );
}
