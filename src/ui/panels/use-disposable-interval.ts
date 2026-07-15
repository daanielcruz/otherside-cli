import { useEffect, useRef } from "react";
import { useRepeatingClock } from "@/ink";

export function useDisposableInterval(
  handler: () => void,
  ms: number,
  opts?: { active?: boolean },
): void {
  const active = opts?.active ?? true;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useRepeatingClock(() => handlerRef.current(), active ? ms : null);

  useEffect(() => {
    return () => {
      handlerRef.current = noop;
    };
  }, []);
}

function noop(): void {}
