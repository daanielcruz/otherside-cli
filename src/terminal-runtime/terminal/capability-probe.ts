import type { TerminalControlResponse } from "@/terminal-runtime/input/key-decoder.js";
import { csi } from "@/terminal-runtime/terminal/control-sequences.js";
import { osc } from "@/terminal-runtime/terminal/operating-system-command.js";

export type TerminalQuery<T extends TerminalControlResponse = TerminalControlResponse> = {
  request: string;

  match: (r: TerminalControlResponse) => r is T;
};

type DecrpmResponse = Extract<TerminalControlResponse, { type: "decrpm" }>;
type CursorPosResponse = Extract<TerminalControlResponse, { type: "cursorPosition" }>;
type OscResponse = Extract<TerminalControlResponse, { type: "osc" }>;
type XtversionResponse = Extract<TerminalControlResponse, { type: "xtversion" }>;

export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === "decrpm" && r.mode === mode,
  };
}

export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi("?6n"),
    match: (r): r is CursorPosResponse => r.type === "cursorPosition",
  };
}

export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, "?"),
    match: (r): r is OscResponse => r.type === "osc" && r.code === code,
  };
}

export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi(">0q"),
    match: (r): r is XtversionResponse => r.type === "xtversion",
  };
}

const SENTINEL = csi("c");

type Pending =
  | {
      kind: "query";
      match: (r: TerminalControlResponse) => boolean;
      resolve: (r: TerminalControlResponse | undefined) => void;
      timeout: ReturnType<typeof setTimeout> | undefined;
    }
  | { kind: "sentinel"; resolve: () => void };

export class TerminalProbe {
  private queue: Pending[] = [];

  constructor(private stdout: NodeJS.WriteStream) {}

  send<T extends TerminalControlResponse>(
    query: TerminalQuery<T>,
    timeoutMs?: number,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      const pending: Extract<Pending, { kind: "query" }> = {
        kind: "query",
        match: query.match,
        resolve: (r) => resolve(r as T | undefined),
        timeout: undefined,
      };
      this.queue.push(pending);
      this.stdout.write(query.request);
      if (timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          const index = this.queue.indexOf(pending);
          if (index !== -1) {
            this.queue.splice(index, 1);
            pending.resolve(undefined);
          }
        }, timeoutMs);
      }
    });
  }

  async requestCursorPosition(timeoutMs: number): Promise<number | undefined> {
    return (await this.send(cursorPosition(), timeoutMs))?.row;
  }

  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ kind: "sentinel", resolve });
      this.stdout.write(SENTINEL);
    });
  }

  onResponse(r: TerminalControlResponse): void {
    const idx = this.queue.findIndex((p) => p.kind === "query" && p.match(r));
    if (idx !== -1) {
      const [q] = this.queue.splice(idx, 1);
      if (q?.kind === "query") {
        if (q.timeout !== undefined) clearTimeout(q.timeout);
        q.resolve(r);
      }
      return;
    }

    if (r.type === "da1") {
      const s = this.queue.findIndex((p) => p.kind === "sentinel");
      if (s === -1) return;
      for (const p of this.queue.splice(0, s + 1)) {
        if (p.kind === "query") {
          if (p.timeout !== undefined) clearTimeout(p.timeout);
          p.resolve(undefined);
        } else p.resolve();
      }
    }
  }
}
