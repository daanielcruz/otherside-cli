import { describe, expect, test } from "bun:test";
import { formContent, formQuestions, schemaFields } from "@/engine/mcp/elicitation-form.ts";
import type { GroupAnswer } from "@/kernel/channels/ask.ts";

const SCHEMA = {
  type: "object",
  properties: {
    branch: { type: "string", title: "Branch", description: "Where to push" },
    count: { type: "integer" },
    force: { type: "boolean" },
    channel: { type: "string", enum: ["stable", "beta"] },
    note: { type: "string" },
  },
  required: ["branch", "count"],
};

function answered(pairs: Record<string, string>): GroupAnswer[] {
  return Object.entries(pairs).map(([question, answer]) => ({ question, answer }));
}

describe("reading the schema", () => {
  test("takes the fields in the order the server declared them", () => {
    expect(schemaFields(SCHEMA).map((field) => field.name)).toEqual([
      "branch",
      "count",
      "force",
      "channel",
      "note",
    ]);
  });

  test("marks what the server said it needs", () => {
    const required = schemaFields(SCHEMA)
      .filter((field) => field.required)
      .map((field) => field.name);
    expect(required).toEqual(["branch", "count"]);
  });

  test("skips a property whose type the protocol does not allow", () => {
    // Nesting is out of scope by the protocol's own rules, so a nested property
    // is not a field the reader can be asked about.
    const nested = { properties: { deep: { type: "object" }, name: { type: "string" } } };
    expect(schemaFields(nested).map((field) => field.name)).toEqual(["name"]);
  });

  test("answers nothing for a schema that declares nothing", () => {
    expect(schemaFields(undefined)).toEqual([]);
    expect(schemaFields({ type: "object" })).toEqual([]);
  });
});

describe("what the reader is asked", () => {
  test("a fixed set of values is a choice, and a boolean is one with two", () => {
    const questions = formQuestions(schemaFields(SCHEMA));
    const channel = questions.find((question) => question.header === "channel");
    const force = questions.find((question) => question.header === "force");

    expect(channel?.options.map((option) => option.label)).toEqual(["stable", "beta"]);
    expect(channel?.allowFreeform).toBe(false);
    expect(force?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  test("anything else is typed, and an optional field says so", () => {
    const questions = formQuestions(schemaFields(SCHEMA));
    const branch = questions.find((question) => question.header === "branch");
    const note = questions.find((question) => question.header === "note");

    expect(branch?.allowFreeform).toBe(true);
    expect(branch?.question).toBe("Branch");
    expect(note?.question).toBe("note (optional)");
  });
});

describe("turning answers into the object the server asked for", () => {
  const fields = schemaFields(SCHEMA);
  const questions = formQuestions(fields);

  test("carries each value as its declared type", () => {
    const filled = formContent(
      fields,
      questions,
      answered({
        Branch: "main",
        count: "3",
        "force (optional)": "Yes",
        "channel (optional)": "beta",
        "note (optional)": "ship it",
      }),
    );

    expect(filled.ok).toBe(true);
    expect(filled.content).toEqual({
      branch: "main",
      count: 3,
      force: true,
      channel: "beta",
      note: "ship it",
    });
  });

  test("leaves out an optional field the reader skipped", () => {
    const filled = formContent(
      fields,
      questions,
      answered({ Branch: "main", count: "1", "note (optional)": "Skip" }),
    );

    expect(filled.content).toEqual({ branch: "main", count: 1 });
  });

  test("refuses when a required field is empty, naming which", () => {
    const filled = formContent(fields, questions, answered({ count: "1" }));
    expect(filled.ok).toBe(false);
    expect(filled.reason).toContain("branch");
  });

  test("refuses a number that is not one, rather than letting the server say so", () => {
    const filled = formContent(fields, questions, answered({ Branch: "main", count: "soon" }));
    expect(filled.ok).toBe(false);
    expect(filled.reason).toContain("count");
  });

  test("refuses a whole-number field given a fraction", () => {
    const filled = formContent(fields, questions, answered({ Branch: "main", count: "1.5" }));
    expect(filled.ok).toBe(false);
    expect(filled.reason).toContain("whole number");
  });

  test("refuses a value outside the set the server declared", () => {
    const filled = formContent(
      fields,
      questions,
      answered({ Branch: "main", count: "1", "channel (optional)": "nightly" }),
    );
    expect(filled.ok).toBe(false);
    expect(filled.reason).toContain("stable, beta");
  });
});
