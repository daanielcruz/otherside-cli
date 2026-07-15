import { useEffect, useState } from "react";
import type { PendingGroup } from "@/kernel/channels/ask.ts";
import { peek, subscribe } from "@/kernel/channels/ask.ts";

export function useAskQueueHead(): PendingGroup | null {
  const [head, setHead] = useState<PendingGroup | null>(() => peek());
  useEffect(() => subscribe((queue) => setHead(queue[0] ?? null)), []);
  return head;
}
