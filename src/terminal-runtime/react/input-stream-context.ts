import { createContext } from "react";
import { EventEmitter } from "@/terminal-runtime/input/event-bus.js";
import type { TerminalProbe } from "@/terminal-runtime/terminal/capability-probe.js";

export type Props = {
  readonly stdin: NodeJS.ReadStream;

  readonly setRawMode: (value: boolean) => void;

  readonly isRawModeSupported: boolean;

  readonly internal_exitOnCtrlC: boolean;

  readonly internal_eventEmitter: EventEmitter;

  readonly internal_querier: TerminalProbe | null;
};

const StdinContext = createContext<Props>({
  stdin: process.stdin,

  internal_eventEmitter: new EventEmitter(),
  setRawMode() {},
  isRawModeSupported: false,

  internal_exitOnCtrlC: true,
  internal_querier: null,
});

StdinContext.displayName = "InternalStdinContext";

export default StdinContext;
