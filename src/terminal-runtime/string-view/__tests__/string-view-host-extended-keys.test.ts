import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { env } from "@/kernel/std/proc/env.ts";
import { currentTerminalHandoff } from "@/terminal-runtime/host/terminal-handoff.ts";
import type { StringComponent } from "@/terminal-runtime/string-view/component.ts";
import {
  openStringView,
  type StringViewController,
} from "@/terminal-runtime/string-view/host/string-view-host.ts";
import {
  DISABLE_KITTY_KEYBOARD,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
} from "@/terminal-runtime/terminal/control-sequences.ts";

const EXTENDED_KEY_REQUEST =
  DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS;

class FakeOutput {
  columns = 80;
  rows = 24;
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

const savedTerminal = env.terminal;
let restored = "";
let controller: StringViewController | null = null;

beforeEach(() => {
  restored = "";
  spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: string) => {
    restored += data;
    return Buffer.byteLength(data);
  }) as typeof fs.writeSync);
});

afterEach(async () => {
  controller?.close();
  await controller?.finished();
  controller = null;
  env.terminal = savedTerminal;
  (fs.writeSync as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function openOn(terminal: string): FakeOutput {
  env.terminal = terminal;
  const output = new FakeOutput();
  const root: StringComponent = { render: () => ["row"] };
  controller = openStringView(root, {
    stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
  });
  return output;
}

describe("string-view host extended key reporting", () => {
  it("asks a capable terminal to report modified keys, again after every handoff", () => {
    const output = openOn("iTerm.app");
    expect(output.written).toContain(EXTENDED_KEY_REQUEST);

    output.written = "";
    const handoff = currentTerminalHandoff();
    handoff?.release();
    expect(restored).toContain(DISABLE_KITTY_KEYBOARD);
    handoff?.reclaim();
    expect(output.written).toContain(EXTENDED_KEY_REQUEST);
  });

  it("leaves the keyboard protocol alone on a terminal that cannot honor it", () => {
    const output = openOn("Apple_Terminal");
    expect(output.written).not.toContain(ENABLE_KITTY_KEYBOARD);
    expect(output.written).not.toContain(ENABLE_MODIFY_OTHER_KEYS);
  });
});
