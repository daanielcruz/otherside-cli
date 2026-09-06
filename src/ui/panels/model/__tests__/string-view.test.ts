import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Registers the provider config the picker lists models from.
import "@/engine/providers/codex/index.ts";
import { availableModelsForProvider } from "@/engine/model/catalog.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { createModelPanel } from "@/ui/panels/model/string-view.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";

const WIDTH = 90;
/** The picker reads the display provider off the broker state. */
const PROVIDER = "codex";

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
  terminalRows: () => 40,
};

const key = (name: string | undefined, overrides: Partial<KeyEventData> = {}): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: undefined,
  raw: undefined,
  isPasted: false,
  ...overrides,
});

const letter = (char: string): KeyEventData => key(char, { sequence: char });

let previousConfigDir: string | undefined;
let configDir: string;
const initialEngine = appStore.getState().engine;

beforeEach(() => {
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-model-panel-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  mkdirSync(configDir, { recursive: true });
  // Placeholder bundle: the picker only asks whether the provider has an entry.
  writeFileSync(
    join(configDir, "credentials.json"),
    JSON.stringify({ [PROVIDER]: { accessToken: "placeholder-not-a-real-token" } }),
    "utf8",
  );
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: { ...readStringViewBrokerState(), provider: PROVIDER, model: firstModel() },
  });
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  dispatch({ type: "engine/setSlice", key: "broker", value: initialEngine.broker });
});

function firstModel(): string {
  return availableModelsForProvider(PROVIDER)[0]?.id ?? "";
}

function secondModel(): string {
  return availableModelsForProvider(PROVIDER)[1]?.id ?? "";
}

async function mountedPanel(onClose: () => void = () => {}): Promise<StringViewPanel> {
  const panel = createModelPanel(onClose);
  panel.mount?.(ctx);
  // The credential bundle is read off disk after mount; the model rows wait on it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return panel;
}

function persistedConfig(): Record<string, unknown> {
  const path = join(configDir, "settings.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("model picker session-only selection", () => {
  it("routes the session to the highlighted model without writing the default", async () => {
    let closed = false;
    const panel = await mountedPanel(() => {
      closed = true;
    });

    panel.handleKey(key("down"));
    panel.handleKey(letter("s"));

    expect(closed).toBe(true);
    expect(readStringViewBrokerState().model).toBe(secondModel());
    expect(persistedConfig().defaultModel).toBeUndefined();
    panel.unmount?.();
  });

  it("still writes the default when the model is taken with Enter", async () => {
    const panel = await mountedPanel();

    panel.handleKey(key("down"));
    panel.handleKey(key("return"));

    expect(readStringViewBrokerState().model).toBe(secondModel());
    expect(persistedConfig().defaultModel).toBe(secondModel());
    panel.unmount?.();
  });

  it("offers the session pick in the footer", async () => {
    const panel = await mountedPanel();
    expect(panel.render(WIDTH).map(stripAnsi).join("\n")).toContain("s this session only");
    panel.unmount?.();
  });

  it("ignores `s` on a row that is not a model", async () => {
    const panel = await mountedPanel();
    panel.handleKey(key("end"));
    const before = readStringViewBrokerState().model;

    panel.handleKey(letter("s"));

    expect(readStringViewBrokerState().model).toBe(before);
    panel.unmount?.();
  });
});

describe("model picker list keys", () => {
  it("takes the nth model on its digit without writing the default away", async () => {
    let closed = false;
    const panel = await mountedPanel(() => {
      closed = true;
    });

    panel.handleKey(key("number", { sequence: "2" }));

    expect(closed).toBe(true);
    expect(readStringViewBrokerState().model).toBe(secondModel());
    expect(persistedConfig().defaultModel).toBe(secondModel());
    panel.unmount?.();
  });

  it("steps with j/k the way it steps with the arrows", async () => {
    const panel = await mountedPanel();
    panel.handleKey(letter("j"));
    panel.handleKey(letter("s"));
    expect(readStringViewBrokerState().model).toBe(secondModel());
    panel.unmount?.();
  });
});
