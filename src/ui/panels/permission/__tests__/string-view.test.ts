import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  ask,
  clear as clearPermissions,
  type PermissionResult,
} from "@/kernel/channels/permission.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { StringViewPermissionPrompt } from "@/ui/panels/permission/string-view.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const WIDTH = 90;
const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
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

const initialEngine = appStore.getState().engine;

function mountedPrompt(): StringViewPermissionPrompt {
  const prompt = new StringViewPermissionPrompt();
  prompt.mount(ctx);
  return prompt;
}

function bashRequest(): Promise<PermissionResult> {
  return ask({
    toolName: "Bash",
    argsPreview: "ls -la",
    rule: "Bash(ls:*)",
    input: { command: "ls -la", description: "List the files" },
  });
}

function text(prompt: StringViewPermissionPrompt): string {
  return prompt.render(WIDTH).map(stripAnsi).join("\n");
}

function plainRows(prompt: StringViewPermissionPrompt): string[] {
  return prompt.render(WIDTH).map((row) => stripAnsi(row).trimEnd());
}

function rowContaining(prompt: StringViewPermissionPrompt, needle: string): string {
  return prompt.render(WIDTH).find((row) => stripAnsi(row).includes(needle)) ?? "";
}

function footerRow(prompt: StringViewPermissionPrompt): string {
  return plainRows(prompt).find((row) => row.includes("Esc to cancel")) ?? "";
}

afterEach(() => {
  clearPermissions();
  dispatch({ type: "engine/setSlice", key: "broker", value: initialEngine.broker });
});

describe("confirmation layout", () => {
  it("sets the title and question at the panel inset and the tool content further in", () => {
    void bashRequest();
    const prompt = mountedPrompt();
    const rows = plainRows(prompt);
    const title = rows.indexOf(" Bash command");

    expect(title).toBeGreaterThan(-1);
    expect(rows.slice(title + 1, title + 4)).toEqual(["", "   ls -la", "   List the files"]);
    prompt.unmount();
  });

  it("puts the first choice directly under the question", () => {
    void bashRequest();
    const prompt = mountedPrompt();
    const rows = plainRows(prompt);
    const question = rows.indexOf(" Do you want to proceed?");

    expect(question).toBeGreaterThan(-1);
    expect(rows[question + 1]).toBe(` ${Glyph.chevron}1. Yes`);
    prompt.unmount();
  });

  it("lays a new file's preview edge to edge right under its path and over the question", () => {
    void ask({
      toolName: "Write",
      argsPreview: "notes.txt",
      rule: null,
      input: { file_path: `${process.cwd()}/placeholder-new-file.txt`, content: "alpha\nbeta\n" },
    });
    const prompt = mountedPrompt();
    const rows = plainRows(prompt);
    const title = rows.indexOf(" Create file");
    const rule = Glyph.boxHLineDashed.repeat(WIDTH);

    expect(rows.slice(title + 1, title + 6)).toEqual([
      " placeholder-new-file.txt",
      rule,
      "  1 alpha",
      "  2 beta",
      rule,
    ]);
    expect(rows[title + 6]).toBe(" Do you want to create placeholder-new-file.txt?");
    expect(rowContaining(prompt, "Do you want to create")).toContain(
      renderTextWithStyles("placeholder-new-file.txt", { color: Color.text, bold: true }),
    );
    prompt.unmount();
  });

  it("sets a read one column in and states a command's reason at the panel inset", () => {
    void ask({
      toolName: "Read",
      argsPreview: "/outside/data.txt",
      rule: null,
      input: { file_path: "/outside/data.txt" },
    });
    const read = mountedPrompt();
    const readRows = plainRows(read);
    expect(readRows.slice(readRows.indexOf(" Read file") + 1).slice(0, 3)).toEqual([
      "",
      "  Read(/outside/data.txt)",
      "",
    ]);
    read.unmount();
    clearPermissions();

    void ask({
      toolName: "Bash",
      argsPreview: "make check",
      rule: null,
      input: { command: "make check", description: "Run checks" },
      reason: "This command requires approval",
    });
    const bash = mountedPrompt();
    const rows = plainRows(bash);
    const command = rows.indexOf("   make check");
    expect(rows.slice(command + 1, command + 6)).toEqual([
      "   Run checks",
      "",
      " This command requires approval",
      "",
      " Do you want to proceed?",
    ]);
    bash.unmount();
  });

  it("wraps a long grant only once its label reaches the frame's right edge", () => {
    const directory = `/placeholder/${"nested-directory-name/".repeat(5)}project`;
    void ask({
      toolName: "Bash",
      argsPreview: "touch created.txt",
      rule: null,
      input: { command: "touch created.txt", description: "Create a marker file" },
      writeDirectories: [directory],
      cwd: directory,
    });
    const prompt = mountedPrompt();
    const first = plainRows(prompt).find((row) => row.includes("always allow access")) ?? "";

    expect(first).toStartWith("   2. Yes, and always allow access to /placeholder/");
    expect(first.length).toBe(WIDTH);
    prompt.unmount();
  });

  it("cuts a whole-tool grant's directory to leave the row clear of the frame's edge", () => {
    void ask({
      toolName: "WebSearch",
      argsPreview: "bun release",
      rule: "WebSearch",
      input: { query: "bun release" },
      cwd: `/placeholder/${"nested-directory-name/".repeat(4)}project`,
    });
    const prompt = mountedPrompt();
    const row = plainRows(prompt).find((line) => line.includes("Web Search commands")) ?? "";

    expect(row).toEndWith("…");
    expect(row.length).toBe(WIDTH - 10);
    prompt.unmount();
  });

  it("answers a fetch by its choices alone: no key hints and no note", () => {
    void ask({
      toolName: "WebFetch",
      argsPreview: "https://example.com",
      rule: "WebFetch(domain:example.com)",
      input: { url: "https://example.com/", prompt: "Summarize it" },
    });
    const prompt = mountedPrompt();
    expect(footerRow(prompt)).toBe("");
    prompt.handleKey(key("tab"));
    expect(text(prompt)).not.toContain("tell Otherside what to do next");
    prompt.unmount();
  });

  it("colors the pointer and the selected label in the accent and keeps the others in text", () => {
    void bashRequest();
    const prompt = mountedPrompt();
    const selected = rowContaining(prompt, "1. Yes");
    const other = rowContaining(prompt, "3. No");

    expect(selected).toContain(renderTextWithStyles(Glyph.chevron, { color: Color.panelAccent }));
    expect(selected).toContain(renderTextWithStyles("1.", { color: Color.muted }));
    expect(selected).toContain(renderTextWithStyles("Yes", { color: Color.panelAccent }));
    expect(other).toContain(renderTextWithStyles("No", { color: Color.text }));
    prompt.unmount();
  });
});

describe("confirmation footer", () => {
  it("offers only cancel and amend, upright", () => {
    void bashRequest();
    const prompt = mountedPrompt();

    expect(footerRow(prompt)).toBe(" Esc to cancel · Tab to amend");
    expect(rowContaining(prompt, "Esc to cancel")).not.toContain("\x1b[3m");
    expect(text(prompt)).not.toContain("Shift+Tab");
    prompt.unmount();
  });

  it("offers amend only while the focused answer takes a note", () => {
    void bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("down"));
    expect(footerRow(prompt)).toBe(" Esc to cancel");
    prompt.handleKey(key("down"));
    expect(footerRow(prompt)).toBe(" Esc to cancel · Tab to amend");
    prompt.unmount();
  });

  it("drops the amend offer while a note is being written", () => {
    void bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab"));
    expect(footerRow(prompt)).toBe(" Esc to cancel");
    prompt.unmount();
  });

  it("leaves Ctrl+E without a meaning", () => {
    void bashRequest();
    const prompt = mountedPrompt();
    const before = text(prompt);

    prompt.handleKey(key("e", { ctrl: true }));
    expect(text(prompt)).toBe(before);
    prompt.unmount();
  });
});

describe("confirmation amend", () => {
  it("puts the caret on the placeholder's first character and dims the rest", () => {
    void bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab"));
    const row = rowContaining(prompt, "1. Yes, ");
    expect(stripAnsi(row).trimEnd()).toBe(
      ` ${Glyph.chevron}1. Yes, and tell Otherside what to do next`,
    );
    expect(row).toContain(renderTextWithStyles("a", { inverse: true }));
    expect(row).toContain(
      renderTextWithStyles("nd tell Otherside what to do next", { color: Color.muted }),
    );
    prompt.unmount();
  });

  it("replaces the placeholder with the note and keeps the caret after it", () => {
    void bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab"));
    prompt.handleKey(key(undefined, { sequence: "go" }));
    const row = rowContaining(prompt, "1. Yes, ");
    expect(stripAnsi(row).trimEnd()).toBe(` ${Glyph.chevron}1. Yes, go`);
    expect(row).toContain(renderTextWithStyles(" ", { inverse: true }));
    prompt.unmount();
  });

  it("refuses the call on Esc while a note is being written", async () => {
    const result = bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab"));
    prompt.handleKey(key(undefined, { sequence: "go" }));
    prompt.handleKey(key("escape"));
    expect(await result).toEqual({ decision: "deny", updates: [] });
    prompt.unmount();
  });
});

describe("confirmation permission mode cycle", () => {
  it("cycles the session mode on shift+tab without advertising it", () => {
    dispatch({
      type: "engine/setSlice",
      key: "broker",
      value: { ...readStringViewBrokerState(), permissionMode: "accept-edits" },
    });
    bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab", { shift: true }));

    expect(readStringViewBrokerState().permissionMode).toBe("yolo");
    expect(text(prompt)).not.toContain("Shift+Tab");
    prompt.unmount();
  });

  it("keeps shift+tab off the amend toggle that plain tab owns", () => {
    bashRequest();
    const prompt = mountedPrompt();

    prompt.handleKey(key("tab", { shift: true }));
    expect(text(prompt)).not.toContain("what to do next");

    prompt.handleKey(key("tab"));
    expect(text(prompt)).toContain("what to do next");
    prompt.unmount();
  });
});
