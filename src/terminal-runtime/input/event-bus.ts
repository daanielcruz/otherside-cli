import { EventEmitter as NodeEventEmitter } from "node:events";
import { Event } from "@/terminal-runtime/input/base-event.js";

export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super();

    this.setMaxListeners(0);
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    if (type === "error") {
      return super.emit(type, ...args);
    }

    const listeners = this.rawListeners(type);

    if (listeners.length === 0) {
      return false;
    }

    const systemEvent = args[0] instanceof Event ? args[0] : null;

    for (const listener of listeners) {
      listener.apply(this, args);

      if (systemEvent?.didStopImmediatePropagation()) {
        break;
      }
    }

    return true;
  }
}
