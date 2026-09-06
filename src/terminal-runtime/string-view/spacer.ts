import type { StringComponent } from "@/terminal-runtime/string-view/component.js";

export class Spacer implements StringComponent {
  private renderedLines: string[];

  constructor(lineCount = 1) {
    this.renderedLines = makeLines(lineCount);
  }

  setLines(lineCount: number): void {
    this.renderedLines = makeLines(lineCount);
  }

  invalidate(): void {}

  render(_width: number): string[] {
    return this.renderedLines;
  }
}

function makeLines(lineCount: number): string[] {
  return Array.from({ length: Math.max(0, Math.floor(lineCount)) }, () => "");
}
