/**
 * The way back after something outside cleared the terminal.
 *
 * The automatic watch only runs where a cursor probe is trustworthy, so on every
 * other terminal a clear leaves the writer believing rows are on screen that are
 * not. This is the reader's escape hatch, and it is held here because the key
 * arrives at a surface that has no reach to the one holding the frame.
 */

let redraw: (() => void) | null = null;

export function setSurfaceRedraw(next: (() => void) | null): void {
  redraw = next;
}

/** Repaints as if nothing were on screen. Answers whether anything could. */
export function redrawSurface(): boolean {
  if (redraw === null) return false;
  redraw();
  return true;
}
