import { useContext } from "react";
import {
  type TerminalSize,
  TerminalSizeContext,
} from "@/terminal-runtime/react/dimensions-context.js";

export function useTerminalDimensions(): TerminalSize {
  const size = useContext(TerminalSizeContext);

  if (!size) {
    throw new Error("useTerminalSize must be used within an Ink App component");
  }

  return size;
}
