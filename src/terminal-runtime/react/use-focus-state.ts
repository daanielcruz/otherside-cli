import { useContext } from "react";
import ViewportActivityContext, {
  type PaneFocusState,
} from "@/terminal-runtime/react/focus-context.js";

export function useIsTerminalFocused(): boolean {
  const { isTerminalFocused } = useContext(ViewportActivityContext);
  return isTerminalFocused;
}

export function useTerminalFocusState(): PaneFocusState {
  const { terminalFocusState } = useContext(ViewportActivityContext);
  return terminalFocusState;
}
