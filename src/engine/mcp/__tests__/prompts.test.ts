import { describe, expect, test } from "bun:test";
import {
  normalizeServerName,
  promptArguments,
  promptCommandName,
  promptText,
  type ServerPrompt,
} from "@/engine/mcp/prompts.ts";

function prompt(over: Partial<ServerPrompt> = {}): ServerPrompt {
  return { server: "notes", name: "summarize", argumentNames: [], ...over };
}

describe("naming a prompt as a command", () => {
  test("carries the server, so two servers offering one prompt stay two commands", () => {
    expect(promptCommandName("notes", "summarize")).toBe("notes:summarize");
    expect(promptCommandName("wiki", "summarize")).toBe("wiki:summarize");
  });

  test("a server name with spaces cannot break slash parsing", () => {
    expect(normalizeServerName("my notes server")).toBe("my_notes_server");
    expect(promptCommandName("my notes", "summarize")).toBe("my_notes:summarize");
  });
});

describe("the arguments a prompt is given", () => {
  test("are named by what it declared, in the order it declared them", () => {
    const declared = prompt({ argumentNames: ["topic", "tone"] });
    expect(promptArguments(declared, "birds formal")).toEqual({ topic: "birds", tone: "formal" });
  });

  test("give the last declared one the rest, so a trailing sentence survives", () => {
    const declared = prompt({ argumentNames: ["topic", "note"] });
    expect(promptArguments(declared, "birds keep it short and kind")).toEqual({
      topic: "birds",
      note: "keep it short and kind",
    });
  });

  test("leave out what was not written rather than sending an empty one", () => {
    const declared = prompt({ argumentNames: ["topic", "tone"] });
    expect(promptArguments(declared, "birds")).toEqual({ topic: "birds" });
    expect(promptArguments(declared, "")).toEqual({});
  });

  test("are nothing at all for a prompt that declared none", () => {
    expect(promptArguments(prompt(), "ignored words")).toEqual({});
  });
});

describe("the text a prompt expands to", () => {
  test("joins every text block the server returned", () => {
    const result = {
      messages: [
        { role: "user", content: { type: "text", text: "First." } },
        { role: "user", content: [{ type: "text", text: "Second." }] },
      ],
    };
    expect(promptText(result, () => null)).toBe("First.\n\nSecond.");
  });

  test("skips a block carrying something other than text", () => {
    // With nowhere to hold it, an image has no reference to stand in for it;
    // dropping it beats an empty line where the reader expected words.
    const result = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: "..." },
            { type: "text", text: "Here." },
          ],
        },
      ],
    };
    expect(promptText(result)).toBe("Here.");
  });

  test("is empty when the server answered with nothing usable", () => {
    expect(promptText({ messages: [] }, () => null)).toBe("");
    expect(promptText(null, () => null)).toBe("");
    expect(promptText({ notMessages: true }, () => null)).toBe("");
  });
});
