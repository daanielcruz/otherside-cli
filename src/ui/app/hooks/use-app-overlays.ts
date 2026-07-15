import { useCallback, useEffect, useMemo, useState } from "react";
import { isMessageRecord, loadSessionTitle, type Session } from "@/engine/session/index.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import {
  dispatch,
  overlayStack,
  sessionTitleActions,
  sessionTitleStore,
  useAppSelect,
  useOverlayOpenStack,
  useSessionTitle,
} from "@/store/index.ts";
import type { Overlay, OverlayName } from "@/ui/panels/registry.tsx";

export interface AppOverlaysDeps {
  session: Session;
  initialOverlay?: OverlayName | undefined;
  initialOverlayChain?: OverlayName[] | undefined;
  initialLoginProvider?: ProviderId | undefined;
}

export function useAppOverlays(deps: AppOverlaysDeps) {
  const { session, initialOverlay, initialOverlayChain, initialLoginProvider } = deps;
  const aiTitle = useSessionTitle();
  useEffect(() => {
    sessionTitleActions.setAttempted(session.records.some(isMessageRecord));
  }, [session]);
  useEffect(() => {
    if (!sessionTitleStore.getState().attempted) return;
    const bootSessionId = session.id;
    void loadSessionTitle(bootSessionId).then((bootTitle) => {
      if (bootTitle === null || session.id !== bootSessionId) return;
      sessionTitleActions.setTitle(bootTitle);
    });
  }, [session]);
  const initialChain = initialOverlayChain ?? (initialOverlay ? [initialOverlay] : []);
  useEffect(() => {
    if (initialChain.length === 0) return;
    for (const name of initialChain) overlayStack.open(name);
  }, [initialChain.length, initialChain]);
  const overlayEntries = useOverlayOpenStack();
  const overlayOpenStack = useMemo(() => overlayEntries.map((o) => o.name), [overlayEntries]);
  const overlay: Overlay = overlayOpenStack[overlayOpenStack.length - 1] ?? null;
  const configInitialTab = useAppSelect((s) => s.view.configInitialTab);
  const setConfigInitialTab = useCallback(
    (tab: "details" | "config" | undefined) => dispatch({ type: "view/setConfigInitialTab", tab }),
    [],
  );
  const [loginInitialProvider, setLoginInitialProvider] = useState<ProviderId | undefined>(
    initialLoginProvider,
  );
  const closeOverlay = (): void => {
    setConfigInitialTab(undefined);
    setLoginInitialProvider(undefined);
    overlayStack.closeTop();
  };

  return {
    aiTitle,
    overlayOpenStack,
    overlay,
    configInitialTab,
    setConfigInitialTab,
    loginInitialProvider,
    setLoginInitialProvider,
    closeOverlay,
  };
}
