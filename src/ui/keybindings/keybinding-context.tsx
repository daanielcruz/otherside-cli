import React, { createContext, type RefObject, useContext, useLayoutEffect, useMemo } from "react";
import type { Key } from "@/ink";
import {
  type ChordResolveResult,
  getBindingDisplayText,
  resolveKeyWithChordState,
} from "./resolver";
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from "./types";

type HandlerRegistration = {
  action: string;
  context: KeybindingContextName;
  handler: () => void;
};

type KeybindingContextValue = {
  resolve: (input: string, key: Key, activeContexts: KeybindingContextName[]) => ChordResolveResult;
  setPendingChord: (pending: ParsedKeystroke[] | null) => void;
  getDisplayText: (action: string, context: KeybindingContextName) => string | undefined;
  bindings: ParsedBinding[];
  pendingChord: ParsedKeystroke[] | null;
  activeContexts: Set<KeybindingContextName>;
  registerActiveContext: (context: KeybindingContextName) => void;
  unregisterActiveContext: (context: KeybindingContextName) => void;
  registerHandler: (registration: HandlerRegistration) => () => void;
  invokeAction: (action: string) => boolean;
};

const KeybindingContext = createContext<KeybindingContextValue | null>(null);

type ProviderProps = {
  bindings: ParsedBinding[];
  pendingChordRef: RefObject<ParsedKeystroke[] | null>;
  pendingChord: ParsedKeystroke[] | null;
  setPendingChord: (pending: ParsedKeystroke[] | null) => void;
  activeContexts: Set<KeybindingContextName>;
  registerActiveContext: (context: KeybindingContextName) => void;
  unregisterActiveContext: (context: KeybindingContextName) => void;
  handlerRegistryRef: RefObject<Map<string, Set<HandlerRegistration>>>;
  children: React.ReactNode;
};

export function KeybindingProvider({
  bindings,
  pendingChordRef,
  pendingChord,
  setPendingChord,
  activeContexts,
  registerActiveContext,
  unregisterActiveContext,
  handlerRegistryRef,
  children,
}: ProviderProps): React.ReactElement {
  const getDisplay = useMemo(
    () => (action: string, context: KeybindingContextName) =>
      getBindingDisplayText(action, context, bindings),
    [bindings],
  );

  const registerHandler = useMemo(
    () =>
      (registration: HandlerRegistration): (() => void) => {
        const registry = handlerRegistryRef.current;
        if (!registry) {
          return () => {};
        }
        if (!registry.has(registration.action)) {
          registry.set(registration.action, new Set());
        }
        registry.get(registration.action)!.add(registration);
        return () => {
          const handlers = registry.get(registration.action);
          if (handlers) {
            handlers.delete(registration);
            if (handlers.size === 0) {
              registry.delete(registration.action);
            }
          }
        };
      },
    [handlerRegistryRef],
  );

  const invokeAction = useMemo(
    () =>
      (action: string): boolean => {
        const registry = handlerRegistryRef.current;
        if (!registry) {
          return false;
        }
        const handlers = registry.get(action);
        if (!handlers || handlers.size === 0) {
          return false;
        }
        for (const registration of handlers) {
          if (activeContexts.has(registration.context)) {
            registration.handler();
            return true;
          }
        }
        return false;
      },
    [activeContexts, handlerRegistryRef],
  );

  const resolve = useMemo(
    () =>
      (input: string, key: Key, contexts: KeybindingContextName[]): ChordResolveResult =>
        resolveKeyWithChordState({
          input,
          key,
          activeContexts: contexts,
          bindings,
          pending: pendingChordRef.current,
        }),
    [bindings, pendingChordRef],
  );

  const value = useMemo<KeybindingContextValue>(
    () => ({
      resolve,
      setPendingChord,
      getDisplayText: getDisplay,
      bindings,
      pendingChord,
      activeContexts,
      registerActiveContext,
      unregisterActiveContext,
      registerHandler,
      invokeAction,
    }),
    [
      resolve,
      setPendingChord,
      getDisplay,
      bindings,
      pendingChord,
      activeContexts,
      registerActiveContext,
      unregisterActiveContext,
      registerHandler,
      invokeAction,
    ],
  );

  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>;
}

export function useKeybindingContext(): KeybindingContextValue {
  const ctx = useContext(KeybindingContext);
  if (!ctx) {
    throw new Error("useKeybindingContext must be used within KeybindingProvider");
  }
  return ctx;
}

export function useOptionalKeybindingContext(): KeybindingContextValue | null {
  return useContext(KeybindingContext);
}

export function useRegisterKeybindingContext(
  context: KeybindingContextName,
  isActive: boolean = true,
): void {
  const keybindingContext = useOptionalKeybindingContext();
  useLayoutEffect(() => {
    if (!keybindingContext || !isActive) {
      return;
    }
    keybindingContext.registerActiveContext(context);
    return () => {
      keybindingContext.unregisterActiveContext(context);
    };
  }, [context, keybindingContext, isActive]);
}
