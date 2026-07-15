import { useCallback, useContext, useLayoutEffect, useRef } from "react";
import PointerLocationContext from "@/terminal-runtime/react/cursor-contract.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

export function useCursorOwner({
  line,
  column,
  active,
  visible = false,
}: {
  line: number;
  column: number;
  active: boolean;
  visible?: boolean;
}): (element: TreeElement | null) => void {
  const setCursorDeclaration = useContext(PointerLocationContext);
  const nodeRef = useRef<TreeElement | null>(null);

  const setNode = useCallback((node: TreeElement | null) => {
    nodeRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (active && node) {
      setCursorDeclaration({ relativeX: column, relativeY: line, node, visible });
    } else {
      setCursorDeclaration(null, node);
    }
  });

  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current);
    };
  }, [setCursorDeclaration]);

  return setNode;
}
