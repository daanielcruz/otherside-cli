import { createContext } from "react";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

export type PointerLocation = {
  readonly relativeX: number;

  readonly relativeY: number;

  readonly node: TreeElement;

  readonly visible: boolean;
};

export type PointerLocationUpdater = (
  declaration: PointerLocation | null,
  clearIfNode?: TreeElement | null,
) => void;

const PointerLocationContext = createContext<PointerLocationUpdater>(() => {});

export default PointerLocationContext;
