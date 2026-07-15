import { afterEach, describe, expect, it } from "bun:test";
import {
  DEVTOOL_SETTINGS,
  type DevtoolSettingName,
  devtoolBoolean,
  devtoolNumber,
  devtoolPath,
  devtoolString,
} from "@/devtools/settings.ts";

const saved = new Map<string, string | undefined>();
for (const setting of Object.values(DEVTOOL_SETTINGS)) {
  saved.set(setting.env, process.env[setting.env]);
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("devtool settings", () => {
  it("keeps every boolean diagnostic disabled by default", () => {
    for (const setting of Object.values(DEVTOOL_SETTINGS)) delete process.env[setting.env];
    for (const [name, setting] of Object.entries(DEVTOOL_SETTINGS)) {
      if (setting.kind === "boolean") {
        expect(devtoolBoolean(name as DevtoolSettingName)).toBe(false);
      }
    }
  });

  it("parses explicit boolean, number, path, and string values", () => {
    process.env.OTHERSIDE_DEBUG_HEAPDUMP = "yes";
    process.env.OTHERSIDE_HEAPDUMP_SAMPLE_MS = "250";
    process.env.OTHERSIDE_DEBUG_LOG_DIR = "/isolated/debug";
    process.env.OTHERSIDE_CODEX_RAW_STREAM_CAPTURE = "/isolated/codex.raw";
    process.env.OTHERSIDE_DEVTOOLS_RESUME_PROVIDER = " codex ";
    expect(devtoolBoolean("heapDumpEnabled")).toBe(true);
    expect(devtoolNumber("heapDumpSampleMs")).toBe(250);
    expect(devtoolPath("debugLogDir")).toBe("/isolated/debug");
    expect(devtoolPath("codexRawStreamCapture")).toBe("/isolated/codex.raw");
    expect(devtoolString("resumeProvider")).toBe("codex");
  });
});
