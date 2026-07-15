import { useEffect, useState } from "react";
import { subscribe as subscribePendingPermission } from "@/kernel/channels/permission.ts";
import { subscribe as subscribePendingAsk } from "@/ui/ask/index.ts";

export function usePendingInteractive(): boolean {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let permActive = false;
    let askActive = false;
    const update = (): void => setPending(permActive || askActive);
    const unsubPerm = subscribePendingPermission((queue) => {
      permActive = queue.length > 0;
      update();
    });
    const unsubAsk = subscribePendingAsk((queue) => {
      askActive = queue.length > 0;
      update();
    });
    return () => {
      unsubPerm();
      unsubAsk();
    };
  }, []);
  return pending;
}
