import throttle from "lodash-es/throttle.js";
import { RENDER_CYCLE_INTERVAL_MS } from "@/terminal-runtime/host/timing.js";

export type RenderScheduler = (() => void) & { cancel?: () => void };

export function createRenderScheduler(render: () => void): RenderScheduler {
  const deferRender = (): void => queueMicrotask(render);
  return throttle(deferRender, RENDER_CYCLE_INTERVAL_MS, {
    leading: true,
    trailing: true,
  });
}
