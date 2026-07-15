import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { PendingChange } from "@/commands/index.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import type { Session } from "@/engine/session/index.ts";
import type { UsageByProvider } from "@/engine/session/usage/provider.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { OverlayName } from "@/ui/panels/registry.tsx";

export interface OverlayStableValue {
  broker: Broker;
  session: Session;
  config: UserConfig;
  version: string;
  tasks?: BackgroundTask[];
  usageByProvider?: UsageByProvider;
  offlineUsageByProvider?: UsageByProvider;
  codexUsage?: CodexUsage | null;
  transcript?: unknown[];
}

export interface OverlayDispatchValue {
  closeOverlay: () => void;
  invalidatePrevFrame?: () => void;
  openOverlay: (name: OverlayName, initialTab?: string) => void;
  onConfigChange?: (config: UserConfig) => void;
  onOpenLogin?: (provider?: ProviderId) => void;
  onCodexUsage?: (usage: CodexUsage | null) => void;
  enqueueChange?: (change: PendingChange, label: string) => void;
  onRewind?: (id: string, mode?: unknown) => void;
  onResumeSession?: (id: string) => void | Promise<void>;
  isTurnRunning?: () => boolean;
  recordPanelCommit?: (commandName: string, feedback: string) => void;
}

const StableContext = createContext<OverlayStableValue | null>(null);
const DispatchContext = createContext<OverlayDispatchValue | null>(null);

export interface OverlayProviderProps {
  stable: OverlayStableValue;
  dispatch: OverlayDispatchValue;
  children: ReactNode;
}

export function OverlayProvider({
  stable,
  dispatch,
  children,
}: OverlayProviderProps): React.JSX.Element {
  const stableMemo = useMemo(() => stable, [stable]);
  const dispatchMemo = useMemo(() => dispatch, [dispatch]);
  return (
    <StableContext.Provider value={stableMemo}>
      <DispatchContext.Provider value={dispatchMemo}>{children}</DispatchContext.Provider>
    </StableContext.Provider>
  );
}

export function useOverlayState(): OverlayStableValue {
  const ctx = useContext(StableContext);
  if (!ctx) throw new Error("useOverlayState must be used inside OverlayProvider");
  return ctx;
}

export function useOverlayDispatch(): OverlayDispatchValue {
  const ctx = useContext(DispatchContext);
  if (!ctx) throw new Error("useOverlayDispatch must be used inside OverlayProvider");
  return ctx;
}

export function useOptionalOverlayState(): OverlayStableValue | null {
  return useContext(StableContext);
}

export function useOptionalOverlayDispatch(): OverlayDispatchValue | null {
  return useContext(DispatchContext);
}
