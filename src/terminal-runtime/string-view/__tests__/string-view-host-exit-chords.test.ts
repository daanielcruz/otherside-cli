import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import type { StringComponent } from "@/terminal-runtime/string-view/component.ts";
import {
  EXIT_HINT_HOLD_MS,
  type ExitChord,
  openStringView,
  type StringViewController,
} from "@/terminal-runtime/string-view/host/string-view-host.ts";

class FakeOutput {
  columns = 80;
  rows = 24;
  written = "";
  private readonly resizeHandlers = new Set<() => void>();

  write(bytes: string): boolean {
    this.written += bytes;
    return true;
  }

  on(event: string, handler: () => void): this {
    if (event === "resize") this.resizeHandlers.add(handler);
    return this;
  }

  off(event: string, handler: () => void): this {
    if (event === "resize") this.resizeHandlers.delete(handler);
    return this;
  }
}

class FakeInput {
  isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];
  private readonly dataHandlers = new Set<(chunk: Buffer) => void>();

  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    this.rawModes.push(raw);
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  on(event: string, handler: (chunk: Buffer) => void): this {
    if (event === "data") this.dataHandlers.add(handler);
    return this;
  }

  off(event: string, handler: (chunk: Buffer) => void): this {
    if (event === "data") this.dataHandlers.delete(handler);
    return this;
  }

  send(bytes: string): void {
    for (const handler of [...this.dataHandlers]) handler(Buffer.from(bytes, "binary"));
  }
}

const CTRL_C = "\x03";
const CTRL_D = "\x04";

function openHost(): {
  input: FakeInput;
  controller: StringViewController;
  hints: [boolean, ExitChord][];
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  const hints: [boolean, ExitChord][] = [];
  const root: StringComponent = { render: () => ["row"] };
  const controller = openStringView(root, {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    onExitHintChange: (armed, chord) => hints.push([armed, chord]),
  });
  return { input, controller, hints };
}

afterEach(() => {
  (fs.writeSync as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function silenceRestoreWrites(): void {
  spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: string) =>
    Buffer.byteLength(data)) as typeof fs.writeSync);
}

describe("string-view host exit chords", () => {
  it("arms a Ctrl+D hint and exits on the second press", async () => {
    silenceRestoreWrites();
    const { input, controller, hints } = openHost();

    input.send(CTRL_D);
    expect(hints).toEqual([[true, "ctrl-d"]]);

    input.send(CTRL_D);
    expect(hints).toEqual([
      [true, "ctrl-d"],
      [false, "ctrl-d"],
    ]);
    await controller.finished();
    expect(input.rawModes.at(-1)).toBe(false);
  });

  it("forgets the armed chord once the window passes, so the next press only re-arms", async () => {
    silenceRestoreWrites();
    const { input, controller, hints } = openHost();

    input.send(CTRL_C);
    await Bun.sleep(EXIT_HINT_HOLD_MS + 100);
    expect(hints.at(-1)).toEqual([false, "ctrl-c"]);

    input.send(CTRL_C);
    expect(hints.at(-1)).toEqual([true, "ctrl-c"]);
    // Still alive: the expired press did not count toward the exit.
    controller.close();
    await controller.finished();
  });

  it("keeps Ctrl+C and Ctrl+D as separate confirmations", async () => {
    silenceRestoreWrites();
    const { input, controller, hints } = openHost();

    input.send(CTRL_C);
    input.send(CTRL_D);
    expect(hints.at(-1)).toEqual([true, "ctrl-d"]);

    input.send(CTRL_C);
    expect(hints.at(-1)).toEqual([true, "ctrl-c"]);

    input.send(CTRL_C);
    await controller.finished();
  });
});
