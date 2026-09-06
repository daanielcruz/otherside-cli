import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import chalk from "chalk";
import {
  promptStore,
  setPromptBashMode,
  setPromptMenuOpen,
  setPromptText,
} from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { StringFocusStack } from "@/terminal-runtime/string-view/focus.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewChromeRegion } from "@/ui/chrome/string-view-chrome-region.ts";
import {
  agentMentionCandidate,
  fileMentionCandidates,
  insertMention,
  mentionSpanAtCaret,
  mentionSuggestions,
} from "@/ui/input/mention-completion.ts";
import type { MentionSources } from "@/ui/input/mention-sources.ts";
import { StringViewAutocomplete } from "@/ui/input/string-view-autocomplete.ts";
import { StringViewMentionPicker } from "@/ui/input/string-view-mention-picker.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";

const originalColorLevel = chalk.level;
const HIGHLIGHT_SGR = "\x1b[38;2;177;185;249m";
const FILES = fileMentionCandidates([
  "README.md",
  "docs/guide.md",
  "notes with spaces.txt",
  "src/index.ts",
  "src/lib/a.ts",
  "src/lib/b.ts",
  "src/lib/c.ts",
  "src/lib/d.ts",
]);
const AGENTS = [
  agentMentionCandidate({ id: "planner", description: "Design implementation plans" }),
  agentMentionCandidate({ id: "reviewer", description: "Review code changes" }),
];

let prompt: StringViewPrompt;
let autocomplete: StringViewAutocomplete;
let picker: StringViewMentionPicker;
let focus: StringFocusStack;
let submitted: string[];

beforeEach(async () => {
  chalk.level = 3;
  setPromptText("");
  setPromptBashMode(false);
  setPromptMenuOpen(false);
  focus = new StringFocusStack();
  submitted = [];
  const context: StringViewContext = {
    requestRender: () => {},
    pushFocus: (target) => focus.push(target),
    popFocus: (target) => focus.pop(target),
    currentFocus: () => focus.current(),
  };
  const sources: MentionSources = {
    loadFiles: async () => FILES,
    listAgents: () => AGENTS,
  };
  prompt = new StringViewPrompt((text) => submitted.push(text));
  autocomplete = new StringViewAutocomplete(prompt);
  picker = new StringViewMentionPicker(prompt, sources);
  prompt.mount(context);
  autocomplete.mount(context);
  picker.mount(context);
  await settleSources();
});

afterEach(() => {
  picker.unmount();
  autocomplete.unmount();
  prompt.unmount();
  setPromptText("");
  setPromptBashMode(false);
  setPromptMenuOpen(false);
  chalk.level = originalColorLevel;
});

describe("mention trigger and cancellation", () => {
  test("opens at the start or after a boundary, but not in a word or bash mode", () => {
    setPromptText("@");
    expect(focus.current()).toBe(picker);
    expect(promptStore.getState().menuOpen).toBe(true);

    setPromptText("prefix @src");
    expect(focus.current()).toBe(picker);

    setPromptText("prefix@src");
    expect(picker.render(80)).toEqual([]);
    expect(focus.current()).toBe(prompt);

    setPromptBashMode(true);
    setPromptText("@src");
    expect(picker.render(80)).toEqual([]);

    setPromptBashMode(false);
    setPromptText("/c");
    expect(focus.current()).toBe(autocomplete);
    expect(promptStore.getState().menuOpen).toBe(true);
  });

  test("escape dismisses until the text changes, while a delimiter closes and reaches the prompt", () => {
    setPromptText("@src");
    focus.route(key("escape", "\u001b"));
    expect(picker.render(80)).toEqual([]);
    expect(prompt.getText()).toBe("@src");

    prompt.applyEdit({ text: "@src", caret: 4 });
    expect(picker.render(80)).toEqual([]);

    focus.route(key(undefined, " "));
    expect(prompt.getText()).toBe("@src ");
    expect(promptStore.getState().menuOpen).toBe(false);
  });

  test("removing the at token or filtering to no results closes the picker", () => {
    setPromptText("@");
    focus.route(key("backspace", "\u007f"));
    expect(prompt.getText()).toBe("");
    expect(picker.render(80)).toEqual([]);

    setPromptText("@no-such-item");
    expect(picker.render(80)).toEqual([]);
    expect(promptStore.getState().menuOpen).toBe(false);
  });
});

describe("mention matching and rendering", () => {
  test("lists top-level paths before agents without section headers", () => {
    setPromptText("@");
    const rows = picker.render(80).map(stripAnsi);

    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 4)).toEqual([
      "+ README.md",
      "+ docs/",
      "+ notes with spaces.txt",
      "+ src/",
    ]);
    expect(rows[4]).toStartWith("* planner (agent) – ");
    expect(rows.join("\n")).not.toContain("Files");
    expect(rows.join("\n")).not.toContain("Agents");
  });

  test("matches case-insensitive substrings and fuzzy subsequences across files and agents", () => {
    expect(mentionSuggestions("REV", FILES, AGENTS)[0]?.value).toBe("reviewer (agent)");
    expect(mentionSuggestions("sgi", FILES, AGENTS)[0]?.value).toBe("docs/guide.md");
  });

  test("wraps shared list keys and clips the menu to six rows", () => {
    setPromptText("@src");
    expect(picker.render(80)[0]).toStartWith(HIGHLIGHT_SGR);

    focus.route(key("up", "\u001b[A"));
    expect(picker.render(80).at(-1)).toStartWith(HIGHLIGHT_SGR);

    focus.route(key("down", "\u001b[B"));
    expect(picker.render(80)[0]).toStartWith(HIGHLIGHT_SGR);

    for (let index = 0; index < 6; index += 1) focus.route(key("n", "\u000e", { ctrl: true }));
    const rows = picker.render(80);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toStartWith(HIGHLIGHT_SGR);
    expect(rows.map(stripAnsi).join("\n")).toContain("src/lib/");
  });

  test("bounds every rendered row to the available width and replaces chrome in the live frame", () => {
    setPromptText("@notes");
    const rows = picker.render(18).map(stripAnsi);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.length <= 18)).toBe(true);
    // The menu owns the footer: the status and mode rows go, and only the bottom
    // margin stays, because that belongs to the frame's last row rather than to
    // whatever happens to be sitting on it.
    expect(new StringViewChromeRegion().render(80)).toEqual(["", ""]);
    expect(rows.join("\n")).not.toContain("to select");
  });
});

describe("mention insertion", () => {
  test("Enter inserts a file mention without submitting", () => {
    setPromptText("@read");
    focus.route(key("return", "\r"));

    expect(prompt.getText()).toBe("@README.md ");
    expect(submitted).toEqual([]);
    expect(focus.current()).toBe(prompt);
  });

  test("Enter inserts a quoted agent mention", () => {
    setPromptText("@review");
    focus.route(key("return", "\r"));

    expect(prompt.getText()).toBe('@"reviewer (agent)" ');
    expect(submitted).toEqual([]);
  });

  test("Tab expands the candidates' common path prefix without closing", () => {
    setPromptText("@src");
    focus.route(key("tab", "\t"));

    expect(prompt.getText()).toBe("@src/");
    expect(focus.current()).toBe(picker);
    expect(promptStore.getState().menuOpen).toBe(true);
  });

  test("Tab accepts the selection when the common prefix is already typed", () => {
    setPromptText("@README.md");
    focus.route(key("tab", "\t"));

    expect(prompt.getText()).toBe("@README.md ");
    expect(focus.current()).toBe(prompt);
  });

  test("quotes file paths containing spaces", () => {
    setPromptText("@notes");
    focus.route(key("return", "\r"));
    expect(prompt.getText()).toBe('@"notes with spaces.txt" ');
  });

  test("replaces the full token around a caret in the middle of the prompt", () => {
    const text = "check @src/idx.ts after";
    const caret = text.indexOf("idx") + 1;
    const span = mentionSpanAtCaret(text, caret);
    expect(span).not.toBeNull();

    const candidate = fileMentionCandidates(["src/index.ts"]).find(
      (option) => option.value === "src/index.ts",
    );
    expect(candidate).toBeDefined();
    const result = insertMention(text, span!, candidate!);
    expect(result).toEqual({
      text: "check @src/index.ts  after",
      caret: "check @src/index.ts ".length,
    });
  });

  test("inserts at an earlier caret without replacing later text", () => {
    prompt.applyEdit({ text: "before @review after", caret: "before @review".length });
    focus.route(key("return", "\r"));

    expect(prompt.getText()).toBe('before @"reviewer (agent)"  after');
    expect(prompt.getCaretOffset()).toBe('before @"reviewer (agent)" '.length);
  });
});

async function settleSources(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function key(
  name: string | undefined,
  sequence: string,
  modifiers: Partial<Pick<KeyEventData, "ctrl" | "meta" | "shift">> = {},
): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
  };
}
