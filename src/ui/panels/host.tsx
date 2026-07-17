import { useLayoutEffect } from "react";
import { discardFrameBaseline } from "@/ink";
import { overlayStack } from "@/store/index.ts";
import { ModalReducedContext } from "@/ui/chrome/modal-reduced-context.ts";
import { useRegisterKeybindingContext } from "@/ui/keybindings/keybinding-context.tsx";
import { useKeybinding } from "@/ui/keybindings/useKeybinding.ts";
import {
  type OverlayDispatchValue,
  OverlayProvider,
  type OverlayStableValue,
} from "@/ui/panels/context";
import {
  type OverlayName,
  type OverlayOpenStack,
  type OverlayRegistryProps,
  renderOverlay,
} from "@/ui/panels/registry.tsx";

export interface OverlayHostProps {
  overlayOpenStack: OverlayOpenStack;
  stable: OverlayStableValue;
  dispatch: OverlayDispatchValue;
  legacyProps: OverlayRegistryProps;
}

export function OverlayHost({
  overlayOpenStack,
  stable,
  dispatch,
  legacyProps,
}: OverlayHostProps): React.JSX.Element | null {
  const overlay = overlayOpenStack[overlayOpenStack.length - 1] ?? null;
  if (overlay === null) return null;
  return (
    <ModalReducedContext.Provider value={true}>
      <OverlayProvider stable={stable} dispatch={dispatch}>
        <FullRepaintOnClose />
        {!overlayOwnsDismiss(overlay) && <OverlayKeybindings name={overlay} />}
        {renderOverlay(overlay, legacyProps)}
      </OverlayProvider>
    </ModalReducedContext.Provider>
  );
}

export function overlayOwnsDismiss(name: OverlayName): boolean {
  return name === "plugins" || name === "resume" || name === "rewind" || name === "orchestration";
}

function OverlayKeybindings({ name }: { name: OverlayName }): null {
  useRegisterKeybindingContext(`Overlay:${name}`);
  useKeybinding(
    "overlay:dismiss",
    () => {
      overlayStack.closeTop();
    },
    { context: `Overlay:${name}` },
  );
  useLayoutEffect(() => {
    return () => {
      overlayStack.clearSlice(name);
    };
  }, [name]);
  return null;
}

function FullRepaintOnClose(): null {
  useLayoutEffect(() => {
    return () => {
      discardFrameBaseline();
    };
  }, []);
  return null;
}
