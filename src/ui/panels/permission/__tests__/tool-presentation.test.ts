import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingPermission } from "@/kernel/channels/permission.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { toolPresentation } from "../tool-presentation.ts";

const WIDTH = 120;

function pending(toolName: string, input: Record<string, unknown>, reason?: string) {
  const request: PendingPermission = {
    id: "p-1",
    toolName,
    argsPreview: "",
    input,
    rule: null,
    resolve: () => {},
    ...(reason === undefined ? {} : { reason }),
  };
  return request;
}

function shown(request: PendingPermission) {
  const presentation = toolPresentation(request, WIDTH);
  return {
    title: presentation.title,
    question: presentation.question.map((segment) => segment.text).join(""),
    emphasized: presentation.question
      .filter((segment) => segment.bold)
      .map((segment) => segment.text),
    body: presentation.body.map((line) => stripAnsi(line).trimEnd()),
    bodyInset: presentation.bodyInset,
    preview: presentation.preview?.map((line) => stripAnsi(line).trimEnd()) ?? null,
    reason: presentation.reason,
  };
}

function withFile<T>(content: string | null, run: (filePath: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "permission-presentation-"));
  const filePath = join(root, "notes.txt");
  if (content !== null) writeFileSync(filePath, content);
  try {
    return run(filePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("permission prompt content", () => {
  it("states why a command needs approval between the command and the question", () => {
    const view = shown(
      pending(
        "Bash",
        { command: "make check", description: "Run checks" },
        "This command requires approval",
      ),
    );
    expect(view.body).toEqual(["make check", "Run checks"]);
    expect(view.bodyInset).toBe(2);
    expect(view.reason).toBe("This command requires approval");
  });

  it("previews a new file's numbered lines in a dashed frame", () => {
    withFile(null, (filePath) => {
      const view = shown(pending("Write", { file_path: filePath, content: "alpha\nbeta\n" }));
      expect(view.title).toBe("Create file");
      expect(view.preview).toEqual([" 1 alpha", " 2 beta"]);
      expect(view.bodyInset).toBe(0);
      expect(view.question).toBe("Do you want to create notes.txt?");
      expect(view.emphasized).toEqual(["notes.txt"]);
    });
  });

  it("previews an edit as a numbered diff in a dashed frame", () => {
    withFile("hello\n", (filePath) => {
      const view = shown(
        pending("Edit", { file_path: filePath, old_string: "hello", new_string: "goodbye" }),
      );
      expect(view.title).toBe("Edit file");
      expect(view.preview).toEqual([" 1 -hello", " 1 +goodbye"]);
      expect(view.question).toBe("Do you want to make this edit to notes.txt?");
    });
  });

  it("names an existing file a write replaces as an overwrite", () => {
    withFile("hello\n", (filePath) => {
      const view = shown(pending("Write", { file_path: filePath, content: "goodbye\n" }));
      expect(view.title).toBe("Overwrite file");
      expect(view.preview).toEqual([" 1 -hello", " 1 +goodbye"]);
      expect(view.question).toBe("Do you want to overwrite notes.txt?");
    });
  });

  it("shows a read as the call it is", () => {
    const view = shown(pending("Read", { file_path: "/outside/data.txt" }));
    expect(view.body).toEqual(["Read(/outside/data.txt)"]);
    expect(view.bodyInset).toBe(1);
  });

  it("shows a fetch's request and the host it reaches", () => {
    const view = shown(pending("WebFetch", { url: "https://example.com", prompt: "Summarize it" }));
    expect(view.body).toEqual([
      "url: https://example.com/",
      "prompt: Summarize it",
      "Otherside wants to fetch content from example.com",
    ]);
  });

  it("shows a search as the call and what it looks for", () => {
    const view = shown(pending("WebSearch", { query: "bun release" }));
    expect(view.title).toBe("Tool use");
    expect(view.body).toEqual([
      'Web Search("bun release")',
      "│ Otherside wants to search the web for: bun release",
    ]);
  });
});
