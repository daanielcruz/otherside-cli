/**
 * The live terminal owner's release/reclaim pair. The string-view host publishes it
 * while it holds the screen; anything that hands the terminal to another program —
 * the suspend ladder, an external editor — borrows it so the modes and raw input are
 * given back cooked on the way out and retaken on the way in. With no host published
 * the borrow is a plain call, which is what non-interactive callers want.
 */
export interface TerminalHandoff {
  /** Hands the terminal back to the shell: cooked input, restored modes. */
  readonly release: () => void;
  /** Retakes the terminal and repaints once the other program is gone. */
  readonly reclaim: () => void;
}

let published: TerminalHandoff | null = null;

export function publishTerminalHandoff(handoff: TerminalHandoff | null): void {
  published = handoff;
}

export function currentTerminalHandoff(): TerminalHandoff | null {
  return published;
}

/** Runs `borrow` with the terminal released, reclaiming it even when `borrow` throws. */
export function withReleasedTerminal<T>(borrow: () => T): T {
  const handoff = published;
  handoff?.release();
  try {
    return borrow();
  } finally {
    handoff?.reclaim();
  }
}
