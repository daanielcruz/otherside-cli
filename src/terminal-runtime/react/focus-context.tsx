import React, { createContext, useMemo, useSyncExternalStore } from "react";
import {
  getPaneFocused,
  getPaneFocusState,
  type PaneFocusState,
  subscribePaneFocus,
} from "@/terminal-runtime/terminal/focus-state.js";

export type { PaneFocusState };

export type ViewportActivityContextProps = {
  readonly isTerminalFocused: boolean;
  readonly terminalFocusState: PaneFocusState;
};

const ViewportActivityContext = createContext<ViewportActivityContextProps>({
  isTerminalFocused: true,
  terminalFocusState: "unknown",
});

ViewportActivityContext.displayName = "TerminalFocusContext";

export function ViewportActivityProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const isTerminalFocused = useSyncExternalStore(subscribePaneFocus, getPaneFocused);
  const terminalFocusState = useSyncExternalStore(subscribePaneFocus, getPaneFocusState);

  const value = useMemo(
    () => ({ isTerminalFocused, terminalFocusState }),
    [isTerminalFocused, terminalFocusState],
  );

  return (
    <ViewportActivityContext.Provider value={value}>{children}</ViewportActivityContext.Provider>
  );
}

export default ViewportActivityContext;
