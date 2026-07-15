const SCROLL_DRAIN_IDLE_MS = 150;

let scrollDraining = false;
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined;

export function markScrollActivity(): void {
  scrollDraining = true;
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer);
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false;
    scrollDrainTimer = undefined;
  }, SCROLL_DRAIN_IDLE_MS);
  scrollDrainTimer.unref?.();
}

export function getIsScrollDraining(): boolean {
  return scrollDraining;
}

export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, SCROLL_DRAIN_IDLE_MS);
      t.unref?.();
    });
  }
}
