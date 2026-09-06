import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.js";

export type BackgroundFill = (text: string) => string;

export interface StringViewContext {
  requestRender(): void;
  pushFocus(target: StringFocusTarget): void;
  popFocus(target: StringFocusTarget): void;
  currentFocus?(): StringFocusTarget | undefined;
  terminalRows?(): number;
}

/**
 * A transfer from settled conversation history into terminal scrollback.
 *
 * Reflowing keeps the same history and can be painted incrementally. Switching means
 * another surface has taken ownership of the terminal and permits the destructive
 * clear needed to establish that surface.
 */
export type ScrollbackBatch =
  | { readonly mode: "idle" }
  | { readonly mode: "add"; readonly rows: readonly string[] }
  | { readonly mode: "reflow"; readonly rows: readonly string[] }
  | { readonly mode: "switch"; readonly rows: readonly string[] };

/** Where the insertion point sits, in rows and cells of the frame just rendered. */
export interface CaretPosition {
  readonly row: number;
  readonly column: number;
}

export interface StringComponent {
  render(width: number): string[];
  /**
   * Where the insertion point sits among the rows this component last returned from
   * `render`, or null when it owns none. Answered from that render rather than
   * recomputed, so asking never costs a second pass or reads a clock a second time.
   */
  caret?(width: number): CaretPosition | null;
  takeScrollbackBatch?(width: number): ScrollbackBatch;
  snapshotScrollback?(width: number): readonly string[];
  mount?(ctx: StringViewContext): void;
  unmount?(): void;
  invalidate?(): void;
  handleKey?(key: KeyEventData): unknown;
}

export class StringContainer implements StringComponent {
  children: StringComponent[] = [];
  /** First row each child contributed to the last render, by child index. */
  private childRowStarts: number[] = [];

  addChild(component: StringComponent): void {
    this.children.push(component);
  }

  removeChild(component: StringComponent): void {
    const index = this.children.indexOf(component);
    if (index !== -1) this.children.splice(index, 1);
  }

  clear(): void {
    this.children = [];
  }

  mount(ctx: StringViewContext): void {
    for (const child of this.children) child.mount?.(ctx);
  }

  unmount(): void {
    for (const child of this.children) child.unmount?.();
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const rowStarts: number[] = [];
    for (const child of this.children) {
      rowStarts.push(lines.length);
      lines.push(...child.render(renderWidth));
    }
    this.childRowStarts = rowStarts;
    return lines;
  }

  caret(width: number): CaretPosition | null {
    const renderWidth = Math.max(1, width);
    for (let index = 0; index < this.children.length; index++) {
      const start = this.childRowStarts[index];
      if (start === undefined) continue;
      const own = this.children[index]?.caret?.(renderWidth);
      if (own === undefined || own === null) continue;
      return { row: start + own.row, column: own.column };
    }
    return null;
  }
}
