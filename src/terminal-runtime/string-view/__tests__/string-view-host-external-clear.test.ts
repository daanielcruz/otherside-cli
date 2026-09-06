import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import type { ScrollbackBatch, StringComponent } from "@/terminal-runtime/string-view/component.ts";
import { openStringView } from "@/terminal-runtime/string-view/host/string-view-host.ts";

const CURSOR_POSITION_QUERY = "\x1b[6n";
/** The terminal answers a homed cursor after the host screen was wiped. */
const HOMED_CURSOR_REPORT = "\x1b[1;1R";
const SETTLED_ROWS = ["settled-first", "settled-second", "settled-third"];
const LIVE_ROWS = ["live-one", "live-two", "live-three", "live-four"];

class FakeOutput {
  columns = 80;
  rows = 24;
  isTTY = true;
  written = "";

  write(bytes: string): boolean {
    this.written += bytes;
    return true;
  }

  on(): this {
    return this;
  }

  off(): this {
    return this;
  }
}

class FakeInput {
  isTTY = true;
  private readonly dataHandlers = new Set<(chunk: Buffer) => void>();

  setRawMode(): this {
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

async function waitUntil(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (ready()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition never became true");
}

afterEach(() => {
  (fs.writeSync as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("string-view host external clear recovery", () => {
  it("resends the settled archive, not just the live frame", async () => {
    spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: string) =>
      Buffer.byteLength(data)) as typeof fs.writeSync);
    const previousTermProgram = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "iTerm.app";

    const input = new FakeInput();
    const output = new FakeOutput();
    // Every settled row is already committed, so the batch has nothing left to
    // hand over — exactly the state a wipe finds after a quiet moment.
    const root: StringComponent = {
      render: () => [...LIVE_ROWS],
      snapshotScrollback: () => SETTLED_ROWS,
      takeScrollbackBatch: (): ScrollbackBatch => ({ mode: "idle" }),
    };
    const controller = openStringView(root, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
    });

    try {
      await waitUntil(() => output.written.includes(CURSOR_POSITION_QUERY));
      output.written = "";
      input.send(HOMED_CURSOR_REPORT);
      await waitUntil(() => output.written.includes(LIVE_ROWS[0] ?? ""));

      for (const row of SETTLED_ROWS) expect(output.written).toContain(row);
      for (const row of LIVE_ROWS) expect(output.written).toContain(row);
    } finally {
      process.env.TERM_PROGRAM = previousTermProgram;
      controller.close();
      await controller.finished();
    }
  });
});
