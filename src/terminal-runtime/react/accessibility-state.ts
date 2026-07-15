import { createContext, useContext } from "react";

export const InternalAccessibilityContext = createContext<boolean>(false);
InternalAccessibilityContext.displayName = "InternalAccessibilityContext";

export function useIsScreenReaderEnabled(): boolean {
  return useContext(InternalAccessibilityContext);
}
