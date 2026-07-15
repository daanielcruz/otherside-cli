import { useCallback } from "react";
import { overlayStack } from "@/store/index.ts";

export function useOverlayClose(onClose?: () => void): () => void {
  return useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    overlayStack.closeTop();
  }, [onClose]);
}
