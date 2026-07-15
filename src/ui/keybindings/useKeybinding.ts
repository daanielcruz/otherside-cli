import { useCallback, useEffect } from "react";
import { type Key, type KeyStroke, useInput } from "@/ink";
import { useOptionalKeybindingContext } from "./keybinding-context.tsx";
import { keybindingContextOwnsInput, type ModalLayer, topModalLayer } from "./modal-focus.ts";
import type { KeybindingContextName } from "./types.ts";

type Options = {
  context?: KeybindingContextName;
  isActive?: boolean;
};

type ResolveContextArgs = {
  context: KeybindingContextName;
  activeContexts: Iterable<KeybindingContextName>;
  topLayer: ModalLayer;
};

export function keybindingResolveContextsForHandler({
  context,
  activeContexts,
  topLayer,
}: ResolveContextArgs): KeybindingContextName[] | null {
  if (!keybindingContextOwnsInput(context, topLayer)) return null;
  if (context === "Global" && topLayer !== "none") return ["Global"];

  const contextsToCheck: KeybindingContextName[] = [...activeContexts, context, "Global"];
  return [...new Set(contextsToCheck)];
}

export function useKeybinding(
  action: string,
  handler: () => void | false | Promise<void>,
  options: Options = {},
): void {
  const { context = "Global", isActive = true } = options;
  const keybindingContext = useOptionalKeybindingContext();

  useEffect(() => {
    if (!keybindingContext || !isActive) return;
    return keybindingContext.registerHandler({ action, context, handler });
  }, [action, context, handler, keybindingContext, isActive]);

  const handleInput = useCallback(
    (input: string, key: Key, event: KeyStroke) => {
      if (!keybindingContext) return;

      const contextsToCheck = keybindingResolveContextsForHandler({
        context,
        activeContexts: keybindingContext.activeContexts,
        topLayer: topModalLayer(),
      });
      if (!contextsToCheck) {
        keybindingContext.setPendingChord(null);
        return;
      }

      const result = keybindingContext.resolve(input, key, contextsToCheck);

      switch (result.type) {
        case "match":
          keybindingContext.setPendingChord(null);
          if (result.action === action) {
            if (handler() !== false) {
              event.stopImmediatePropagation();
            }
          }
          break;
        case "chord_started":
          keybindingContext.setPendingChord(result.pending);
          event.stopImmediatePropagation();
          break;
        case "chord_cancelled":
          keybindingContext.setPendingChord(null);
          break;
        case "unbound":
          keybindingContext.setPendingChord(null);
          event.stopImmediatePropagation();
          break;
        case "none":
          break;
      }
    },
    [action, context, handler, keybindingContext],
  );

  useInput(handleInput, { isActive });
}

export function useKeybindings(
  handlers: Record<string, () => void | false | Promise<void>>,
  options: Options = {},
): void {
  const { context = "Global", isActive = true } = options;
  const keybindingContext = useOptionalKeybindingContext();

  useEffect(() => {
    if (!keybindingContext || !isActive) return;

    const unregisterFns: Array<() => void> = [];
    for (const [action, handler] of Object.entries(handlers)) {
      unregisterFns.push(keybindingContext.registerHandler({ action, context, handler }));
    }

    return () => {
      for (const unregister of unregisterFns) {
        unregister();
      }
    };
  }, [context, handlers, keybindingContext, isActive]);

  const handleInput = useCallback(
    (input: string, key: Key, event: KeyStroke) => {
      if (!keybindingContext) return;

      const contextsToCheck = keybindingResolveContextsForHandler({
        context,
        activeContexts: keybindingContext.activeContexts,
        topLayer: topModalLayer(),
      });
      if (!contextsToCheck) {
        keybindingContext.setPendingChord(null);
        return;
      }

      const result = keybindingContext.resolve(input, key, contextsToCheck);

      switch (result.type) {
        case "match":
          keybindingContext.setPendingChord(null);
          if (result.action in handlers) {
            const handler = handlers[result.action];
            if (handler && handler() !== false) {
              event.stopImmediatePropagation();
            }
          }
          break;
        case "chord_started":
          keybindingContext.setPendingChord(result.pending);
          event.stopImmediatePropagation();
          break;
        case "chord_cancelled":
          keybindingContext.setPendingChord(null);
          break;
        case "unbound":
          keybindingContext.setPendingChord(null);
          event.stopImmediatePropagation();
          break;
        case "none":
          break;
      }
    },
    [context, handlers, keybindingContext],
  );

  useInput(handleInput, { isActive });
}
