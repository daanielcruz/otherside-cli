import { getQueueMessages, queueActions } from "@/store/index.ts";

export function createPendingInputDrainer() {
  return () => {
    const current = getQueueMessages();
    if (current.length === 0) return [];
    const messageEntries = current.filter((q) => !q.expanded.trim().startsWith("/"));
    const drained = messageEntries.map((q) => ({
      text: q.expanded,
      blocks: q.blocks ?? [{ type: "text" as const, text: q.expanded }],
      ...(q.pastedImages && q.pastedImages.length > 0 ? { pastedImages: q.pastedImages } : {}),
      ...(q.remotePayload ? { remotePayload: q.remotePayload } : {}),
    }));
    const keptSlashEntries = current.filter((q) => q.expanded.trim().startsWith("/"));
    queueActions.replace(keptSlashEntries);
    return drained;
  };
}
