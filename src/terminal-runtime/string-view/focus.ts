import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";

export interface StringFocusTarget {
  handleKey(key: KeyEventData): unknown;
}

/** Last-pushed target owns keyboard input until it is popped. */
export class StringFocusStack {
  private readonly targets: StringFocusTarget[] = [];

  push(target: StringFocusTarget): void {
    this.pop(target);
    this.targets.push(target);
  }

  pop(target: StringFocusTarget): void {
    const index = this.targets.lastIndexOf(target);
    if (index !== -1) this.targets.splice(index, 1);
  }

  route(key: KeyEventData): boolean {
    const target = this.targets.at(-1);
    if (!target) return false;
    return target.handleKey(key) !== false;
  }

  clear(): void {
    this.targets.length = 0;
  }

  current(): StringFocusTarget | undefined {
    return this.targets.at(-1);
  }
}
