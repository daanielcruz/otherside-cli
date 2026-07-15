import { useContext, useEffect } from "react";
import stripAnsi from "strip-ansi";
import { TerminalOutputContext } from "@/terminal-runtime/react/use-terminal-alert.js";
import { OSC, osc } from "@/terminal-runtime/terminal/operating-system-command.js";

export function useWindowCaption(title: string | null): void {
  const writeRaw = useContext(TerminalOutputContext);

  useEffect(() => {
    if (title === null || !writeRaw) return;

    const clean = stripAnsi(title);

    if (process.platform === "win32") {
      process.title = clean;
    } else {
      writeRaw(osc(OSC.SET_TITLE_AND_ICON, clean));
    }
  }, [title, writeRaw]);
}
