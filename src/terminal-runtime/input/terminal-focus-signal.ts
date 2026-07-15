import { Event } from "@/terminal-runtime/input/base-event.js";

export type WindowActivityStateType = "terminalfocus" | "terminalblur";

export class WindowActivityStateEvent extends Event {
  readonly type: WindowActivityStateType;

  constructor(type: WindowActivityStateType) {
    super();
    this.type = type;
  }
}
