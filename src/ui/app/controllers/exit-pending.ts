import { useCallback, useEffect, useMemo, useState } from "react";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";

const PENDING_TIMEOUT_MS = 800;

export type ExitKey = "Ctrl-C" | "Ctrl-D";

export interface ExitPendingController {
  readonly pendingKey: ExitKey | null;
  readonly clear: () => void;
  readonly arm: (keyName: ExitKey) => void;
  readonly isArmed: (keyName: ExitKey) => boolean;
}

export function useExitPendingController(): ExitPendingController {
  const [pendingKey, setPendingKey] = useState<ExitKey | null>(null);
  const dispatch = useMemo(
    () => createAutoClearDispatch<ExitKey>({ holdMs: PENDING_TIMEOUT_MS }),
    [],
  );

  const clear = useCallback((): void => {
    dispatch.clear();
    setPendingKey(null);
  }, [dispatch]);

  const arm = useCallback(
    (keyName: ExitKey): void => {
      setPendingKey(keyName);
      dispatch.arm({
        key: keyName,
        onTimeout: () => setPendingKey(null),
      });
    },
    [dispatch],
  );

  const isArmed = useCallback((keyName: ExitKey): boolean => dispatch.isArmed(keyName), [dispatch]);

  useEffect(() => {
    return () => dispatch.clear();
  }, [dispatch]);

  return { pendingKey, clear, arm, isArmed };
}
