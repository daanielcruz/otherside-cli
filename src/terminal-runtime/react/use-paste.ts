import useInput from "@/terminal-runtime/react/use-key-events.js";

export type UsePasteOptions = { isActive?: boolean };

export function usePaste(handler: (text: string) => void, options: UsePasteOptions = {}): void {
  useInput((input, _key, event) => {
    if (event.keypress.isPasted) {
      handler(input);
    }
  }, options);
}
