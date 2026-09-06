import { refreshServerPrompts } from "@/engine/mcp/prompts.ts";
import { watchInboundNotice } from "@/kernel/mcp/protocol/inbound.ts";
import { refreshMcpTools } from "@/kernel/mcp/runtime/manager.ts";

/**
 * What a server tells us, unasked.
 *
 * A server that changes what it offers says so instead of waiting to be asked
 * again, and a client that ignores it goes on offering a catalog that no longer
 * exists — the model then calls a tool the server dropped.
 */

export const TOOLS_CHANGED_NOTICE = "notifications/tools/list_changed";
export const RESOURCES_CHANGED_NOTICE = "notifications/resources/list_changed";
export const PROMPTS_CHANGED_NOTICE = "notifications/prompts/list_changed";

/**
 * Starts listening. Returns a teardown.
 *
 * Several servers changing at once collapse into one re-read: the refresh reads
 * every server anyway, so running it per notice would only repeat the work.
 */
export function watchServerNotices(cwd: () => string, settleMs = SETTLE_MS): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (settle !== undefined) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = undefined;
      void refreshMcpTools(cwd())
        .then(() => refreshServerPrompts())
        .catch(() => {});
    }, settleMs);
    settle.unref?.();
  };

  const stops = [TOOLS_CHANGED_NOTICE, RESOURCES_CHANGED_NOTICE, PROMPTS_CHANGED_NOTICE].map(
    (method) => watchInboundNotice(method, scheduleRefresh),
  );

  return () => {
    for (const stop of stops) stop();
    if (settle !== undefined) clearTimeout(settle);
    settle = undefined;
  };
}

/** How long the notices are gathered before the catalog is re-read. */
const SETTLE_MS = 250;
