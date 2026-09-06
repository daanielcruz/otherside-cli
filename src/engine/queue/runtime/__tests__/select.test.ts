import { describe, expect, it } from "bun:test";
import { parseSelectionResponse } from "../parse.ts";
import { type MemoryHeader, renderMemoryManifest } from "../scan.ts";

describe("parseSelectionResponse", () => {
  it("parses a plain JSON object", () => {
    expect(parseSelectionResponse('{"selected_memories": ["a.md", "b.md"]}')).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("parses an empty selection", () => {
    expect(parseSelectionResponse('{"selected_memories": []}')).toEqual([]);
  });

  it("strips a markdown code fence", () => {
    const raw = '```json\n{"selected_memories": ["feedback_testing.md"]}\n```';
    expect(parseSelectionResponse(raw)).toEqual(["feedback_testing.md"]);
  });

  it("strips a bare code fence with surrounding whitespace", () => {
    const raw = '  ```\n{"selected_memories": ["x.md"]}\n```  ';
    expect(parseSelectionResponse(raw)).toEqual(["x.md"]);
  });

  it("drops non-string entries", () => {
    expect(parseSelectionResponse('{"selected_memories": ["a.md", 3, null, "b.md"]}')).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseSelectionResponse("not json")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseSelectionResponse('["a.md"]')).toBeNull();
  });

  it("returns null when selected_memories is missing", () => {
    expect(parseSelectionResponse('{"other": []}')).toBeNull();
  });

  it("returns null when selected_memories is not an array", () => {
    expect(parseSelectionResponse('{"selected_memories": "a.md"}')).toBeNull();
  });
});

describe("renderMemoryManifest", () => {
  const header = (overrides: Partial<MemoryHeader>): MemoryHeader => ({
    filename: "topic.md",
    filePath: "/mem/topic.md",
    mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5),
    description: null,
    type: undefined,
    ...overrides,
  });

  it("renders type tag, filename, timestamp, and description", () => {
    const manifest = renderMemoryManifest([
      header({
        filename: "user_role.md",
        type: "user",
        description: "user is a data scientist",
      }),
    ]);
    expect(manifest).toBe(
      "- [user] user_role.md (2026-01-02T03:04:05.000Z): user is a data scientist",
    );
  });

  it("omits the tag and description when absent", () => {
    const manifest = renderMemoryManifest([header({})]);
    expect(manifest).toBe("- topic.md (2026-01-02T03:04:05.000Z)");
  });

  it("joins entries with newlines", () => {
    const manifest = renderMemoryManifest([
      header({ filename: "a.md" }),
      header({ filename: "b.md" }),
    ]);
    expect(manifest.split("\n")).toHaveLength(2);
  });
});
