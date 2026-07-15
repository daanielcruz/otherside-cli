import type { DesignSnapshot } from "@/design/types.ts";

export type DesignPushHook = (cwd: string, snapshot: DesignSnapshot) => void;

let hook: DesignPushHook | null = null;

export function setDesignPushHook(next: DesignPushHook | null): void {
  hook = next;
}

export function emitDesignPush(cwd: string, snapshot: DesignSnapshot): void {
  if (!hook) return;
  try {
    hook(cwd, snapshot);
  } catch {}
}
