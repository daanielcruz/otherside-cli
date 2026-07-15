import { useContext } from "react";
import StaticFlushContext from "@/terminal-runtime/react/scrollback-context.js";

export function useScrollbackCommit() {
  return useContext(StaticFlushContext);
}
