import { describe, expect, it } from "bun:test";
import {
  type AskDesignQuestionsInput,
  AskDesignQuestionsTool,
  parseAskDesignQuestionsInput,
} from "@/design/capabilities/tools/AskDesignQuestions.ts";
import { DESIGN_FORK_BODY } from "@/design/harness.ts";

const REQUIRED_OPTIONS = ["Explore a few options", "Decide for me", "Other"];

interface QuestionSchemaShape {
  required: string[];
  additionalProperties: boolean;
  properties: {
    questions: {
      items: {
        properties: {
          kind: { enum: readonly string[] };
          options: { items: { type: string } };
          multi: { type: string };
          accept: { type: string; description: string };
          multiSelect?: unknown;
        };
        additionalProperties: boolean;
      };
    };
  };
}

function validInput(): AskDesignQuestionsInput {
  return {
    title: "Product direction",
    questions: [
      {
        id: "visual_direction",
        kind: "text-options",
        title: "Which direction should lead?",
        options: ["Quiet", ...REQUIRED_OPTIONS],
        multi: true,
      },
      {
        id: "reference",
        kind: "file",
        title: "Attach a reference",
        accept: "image/*,.png",
      },
    ],
  };
}

describe("ask_questions contract", () => {
  it("exposes the titled five-kind schema with string options", () => {
    const schema = AskDesignQuestionsTool.inputSchema as unknown as QuestionSchemaShape;
    expect(schema.required).toEqual(["title", "questions"]);
    expect(schema.additionalProperties).toBe(false);
    const item = schema.properties.questions.items;
    expect(item.properties.kind.enum).toEqual([
      "text-options",
      "svg-options",
      "slider",
      "file",
      "freeform",
    ]);
    expect(item.properties.options.items).toEqual({ type: "string" });
    expect(item.properties.multi).toEqual({ type: "boolean" });
    expect(item.properties.accept).toEqual({
      type: "string",
      description: "Browser image filter such as image/* or .png,.jpg.",
    });
    expect(item.properties.multiSelect).toBeUndefined();
    expect(item.additionalProperties).toBe(false);
  });

  it("tells the agent to pause on one titled form", () => {
    expect(DESIGN_FORK_BODY).toContain("call ask_questions once with one titled form");
    expect(DESIGN_FORK_BODY).toContain(
      "Do not plan, edit, or answer the questions yourself while it is open",
    );
  });

  it("accepts unique ids and all required text choices", () => {
    expect(parseAskDesignQuestionsInput(validInput())).toEqual(validInput());
  });

  it("rejects invalid slider boundaries", () => {
    const invalidSliders = [
      [{ min: 10, max: 1 }, "questions[0].min must not exceed max"],
      [{ min: 0, max: 10, step: 0 }, "questions[0].step must be greater than zero"],
      [{ min: 0, max: 10, default: -1 }, "questions[0].default must not be less than min"],
      [{ min: 0, max: 10, default: 11 }, "questions[0].default must not exceed max"],
    ] as const;
    for (const [slider, message] of invalidSliders) {
      expect(
        parseAskDesignQuestionsInput({
          title: "Slider validation",
          questions: [{ id: "amount", kind: "slider", title: "Amount", ...slider }],
        }),
      ).toBe(message);
    }
  });

  it("rejects a text question missing flexible choices", () => {
    const input = validInput();
    input.questions[0]!.options = ["Quiet", "Other"];
    expect(parseAskDesignQuestionsInput(input)).toContain("Explore a few options, Decide for me");
  });

  it("rejects duplicate answer ids", () => {
    const input = validInput();
    input.questions[1]!.id = input.questions[0]!.id;
    expect(parseAskDesignQuestionsInput(input)).toBe("duplicate question id: visual_direction");
  });
});
