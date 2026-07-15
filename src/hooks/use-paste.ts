import { useInput } from "@/ink";

export type UsePasteOptions = { isActive?: boolean };

export function usePaste(handler: (text: string) => void, options: UsePasteOptions = {}): void {
  useInput((input, _key, event) => {
    if (event.keypress.isPasted) {
      handler(input);
    }
  }, options);
}
