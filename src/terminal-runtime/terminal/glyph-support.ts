import { env } from "@/kernel/std/proc/env.ts";

export function canRenderGeometricShapesCleanly(terminal = env.terminal): boolean {
  return terminal !== "ghostty";
}
