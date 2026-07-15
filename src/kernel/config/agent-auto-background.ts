import { isEnvTruthy } from "@/kernel/std/proc/env.ts";

// Agent calls detach by default so their caller can continue; a nested owner
// remains alive until it drains each child's completion notification.
export function isAgentAutoBackgroundEnabled(): boolean {
  if (isEnvTruthy(process.env.OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND)) {
    return false;
  }
  return true;
}
