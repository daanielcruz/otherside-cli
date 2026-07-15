import type React from "react";
import { useCallback, useRef, useState } from "react";
import { defaultBindings } from "./bindings.ts";
import { KeybindingProvider, useOptionalKeybindingContext } from "./keybinding-context.tsx";
import type { KeybindingContextName, ParsedKeystroke } from "./types.ts";

type Props = {
  children: React.ReactNode;
};

export function KeybindingSetup({ children }: Props): React.ReactElement {
  const existing = useOptionalKeybindingContext();
  if (existing) return <>{children}</>;
  return <KeybindingSetupInner>{children}</KeybindingSetupInner>;
}

function KeybindingSetupInner({ children }: Props): React.ReactElement {
  const [pendingChord, setPendingChordState] = useState<ParsedKeystroke[] | null>(null);
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null);
  const handlerRegistryRef = useRef(new Map());
  const activeContextsRef = useRef<Set<KeybindingContextName>>(new Set());

  const setPendingChord = useCallback((next: ParsedKeystroke[] | null) => {
    pendingChordRef.current = next;
    setPendingChordState(next);
  }, []);

  const registerActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.add(context);
  }, []);

  const unregisterActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.delete(context);
  }, []);

  return (
    <KeybindingProvider
      bindings={defaultBindings}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={activeContextsRef.current}
      registerActiveContext={registerActiveContext}
      unregisterActiveContext={unregisterActiveContext}
      handlerRegistryRef={handlerRegistryRef}
    >
      {children}
    </KeybindingProvider>
  );
}
