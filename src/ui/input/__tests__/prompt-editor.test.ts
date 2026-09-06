import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { publishTerminalHandoff } from "@/terminal-runtime/host/terminal-handoff.ts";
import {
  defaultEditorIo,
  type ExternalEditorIo,
  editorLaunchFor,
  editPromptExternally,
  editTextExternally,
  normalizeEditedText,
} from "@/ui/input/prompt-editor.ts";

interface FakeEditor extends ExternalEditorIo {
  readonly log: string[];
  readonly seen: { path: string | null; contents: string | null };
}

function fakeEditor(
  saved: string | null,
  options: { readonly fails?: boolean; readonly throwsOnRead?: boolean } = {},
): FakeEditor {
  const log: string[] = [];
  const seen: { path: string | null; contents: string | null } = { path: null, contents: null };
  return {
    log,
    seen,
    createFile(contents) {
      seen.contents = contents;
      seen.path = "/fake/tmp/prompt.md";
      log.push("create");
      return seen.path;
    },
    run(launch, path) {
      log.push(`run:${launch.command} ${[...launch.args, path].join(" ")}`);
      return options.fails !== true;
    },
    readFile() {
      log.push("read");
      if (options.throwsOnRead === true) throw new Error("unreadable");
      return saved ?? "";
    },
    discard() {
      log.push("discard");
    },
  };
}

afterEach(() => {
  publishTerminalHandoff(null);
});

describe("editorLaunchFor", () => {
  it("falls back to vi when the environment names no editor", () => {
    expect(editorLaunchFor({})).toEqual({ command: "vi", args: [] });
    expect(editorLaunchFor({ EDITOR: "   " })).toEqual({ command: "vi", args: [] });
  });

  it("keeps the flags of a configured editor", () => {
    expect(editorLaunchFor({ EDITOR: "nano -w" })).toEqual({ command: "nano", args: ["-w"] });
  });
});

describe("normalizeEditedText", () => {
  it("drops the newline the editor adds on save and normalizes CRLF", () => {
    expect(normalizeEditedText("one\r\ntwo\n")).toBe("one\ntwo");
    expect(normalizeEditedText("body\n\n\n")).toBe("body");
    expect(normalizeEditedText("")).toBe("");
  });
});

describe("editTextExternally", () => {
  it("hands the draft over and takes back what was saved", () => {
    const io = fakeEditor("rewritten prompt\n");

    expect(editTextExternally("draft", io, { EDITOR: "nano" })).toBe("rewritten prompt");
    expect(io.seen.contents).toBe("draft");
    expect(io.log).toEqual(["create", "run:nano /fake/tmp/prompt.md", "read", "discard"]);
  });

  it("keeps the draft when the editor exits badly, and still discards the file", () => {
    const io = fakeEditor("ignored", { fails: true });

    expect(editTextExternally("draft", io, {})).toBeNull();
    expect(io.log.at(-1)).toBe("discard");
  });

  it("keeps the draft when the file cannot be read back", () => {
    const io = fakeEditor(null, { throwsOnRead: true });

    expect(editTextExternally("draft", io, {})).toBeNull();
    expect(io.log.at(-1)).toBe("discard");
  });
});

describe("editPromptExternally", () => {
  it("releases the terminal for the editor and reclaims it after", () => {
    const io = fakeEditor("edited");
    const order: string[] = [];
    publishTerminalHandoff({
      release: () => order.push("release"),
      reclaim: () => order.push("reclaim"),
    });

    expect(editPromptExternally("draft", io, {})).toBe("edited");
    expect(order).toEqual(["release", "reclaim"]);
    expect(io.log.indexOf("run:vi /fake/tmp/prompt.md")).toBeGreaterThan(-1);
  });
});

describe("defaultEditorIo", () => {
  it("stages the draft in the OS temp directory and removes it after", () => {
    const path = defaultEditorIo.createFile("staged draft");

    expect(path.startsWith(tmpdir())).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("staged draft");

    defaultEditorIo.discard(path);
    expect(existsSync(path)).toBe(false);
  });
});
