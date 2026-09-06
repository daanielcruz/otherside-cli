/**
 * Chrome surfaces outside the progress block can hold an animated glyph (a busy
 * panel's spinner). They register a predicate here and the shared frame clock
 * repaints while any client reports animation — one tick source, no per-surface
 * timers.
 */

const clients = new Set<() => boolean>();

export function registerFrameClient(isAnimating: () => boolean): () => void {
  clients.add(isAnimating);
  return () => {
    clients.delete(isAnimating);
  };
}

export function anyFrameClientAnimating(): boolean {
  for (const client of clients) {
    if (client()) return true;
  }
  return false;
}
