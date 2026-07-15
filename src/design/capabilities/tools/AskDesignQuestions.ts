import type { ToolSchema } from "@/engine/tools/contract.ts";

export const DESIGN_QUESTION_KINDS = [
  "text-options",
  "svg-options",
  "slider",
  "file",
  "freeform",
] as const;

export type DesignQuestionKind = (typeof DESIGN_QUESTION_KINDS)[number];

export interface DesignQuestion {
  id: string;
  kind: DesignQuestionKind;
  title: string;
  subtitle?: string;
  options?: string[];
  multi?: boolean;
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  accept?: string;
}

export interface AskDesignQuestionsInput {
  title: string;
  questions: DesignQuestion[];
}

const QUESTION_KIND_SET: ReadonlySet<string> = new Set(DESIGN_QUESTION_KINDS);
const REQUIRED_TEXT_OPTIONS = ["Explore a few options", "Decide for me", "Other"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function parseOptions(value: unknown, index: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((option) => typeof option !== "string")) {
    throw new Error(`questions[${index}].options must be an array of strings`);
  }
  return value as string[];
}

function parseQuestion(value: unknown, index: number): DesignQuestion {
  if (!isRecord(value)) throw new Error(`questions[${index}] must be an object`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`questions[${index}].id must be a non-empty string`);
  }
  if (typeof value.kind !== "string" || !QUESTION_KIND_SET.has(value.kind)) {
    throw new Error(`questions[${index}].kind is invalid`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`questions[${index}].title must be a non-empty string`);
  }
  if (value.multi !== undefined && typeof value.multi !== "boolean") {
    throw new Error(`questions[${index}].multi must be a boolean`);
  }

  const options = parseOptions(value.options, index);
  if (value.kind === "text-options") {
    const missing = REQUIRED_TEXT_OPTIONS.filter((option) => !options?.includes(option));
    if (missing.length > 0) {
      throw new Error(`questions[${index}].options is missing: ${missing.join(", ")}`);
    }
  }
  const subtitle = optionalString(value.subtitle, `questions[${index}].subtitle`);
  const min = optionalNumber(value.min, `questions[${index}].min`);
  const max = optionalNumber(value.max, `questions[${index}].max`);
  const step = optionalNumber(value.step, `questions[${index}].step`);
  const defaultValue = optionalNumber(value.default, `questions[${index}].default`);
  const accept = optionalString(value.accept, `questions[${index}].accept`);
  if (value.kind === "slider") {
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`questions[${index}].min must not exceed max`);
    }
    if (step !== undefined && step <= 0) {
      throw new Error(`questions[${index}].step must be greater than zero`);
    }
    if (defaultValue !== undefined && min !== undefined && defaultValue < min) {
      throw new Error(`questions[${index}].default must not be less than min`);
    }
    if (defaultValue !== undefined && max !== undefined && defaultValue > max) {
      throw new Error(`questions[${index}].default must not exceed max`);
    }
  }

  return {
    id: value.id,
    kind: value.kind as DesignQuestionKind,
    title: value.title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(typeof value.multi === "boolean" ? { multi: value.multi } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(accept !== undefined ? { accept } : {}),
  };
}

export function parseAskDesignQuestionsInput(input: unknown): AskDesignQuestionsInput | string {
  if (!isRecord(input)) return "input must be an object";
  if (typeof input.title !== "string" || input.title.length === 0) {
    return "title must be a non-empty string";
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return "questions must be a non-empty array";
  }
  try {
    const questions = input.questions.map(parseQuestion);
    const ids = new Set<string>();
    for (const question of questions) {
      if (ids.has(question.id)) return `duplicate question id: ${question.id}`;
      ids.add(question.id);
    }
    return { title: input.title, questions };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const AskDesignQuestionsTool: ToolSchema = {
  name: "ask_questions",
  description:
    'Present one titled form of questions that only the user can settle. Timing: ask AFTER doing your own homework — read the brief, inspect the project files, and research whatever you can discover yourself; never ask for facts the context already answers. Put the highest-impact questions first. Use text-options for labeled choices, svg-options for visual choices, slider for numeric ranges, file for a project upload, and freeform for open input. Every text-options item must include "Explore a few options", "Decide for me", and "Other". For an open-ended new project, ask at least ten focused questions; skip this tool for small changes, follow-ups, or briefs that already settle the decisions. Contract: presenting the form ends your activity for this step — produce nothing else until the user\'s answers come back as this call\'s result, then continue with them as your direction.',
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short heading for the full form.",
      },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Stable snake_case key used for this answer.",
            },
            kind: {
              type: "string",
              enum: DESIGN_QUESTION_KINDS,
            },
            title: { type: "string" },
            subtitle: { type: "string" },
            options: {
              type: "array",
              description:
                "Text labels for text-options, or complete inline SVG strings for svg-options.",
              items: { type: "string" },
            },
            multi: { type: "boolean" },
            min: { type: "number" },
            max: { type: "number" },
            step: { type: "number" },
            default: { type: "number" },
            accept: {
              type: "string",
              description: "Browser image filter such as image/* or .png,.jpg.",
            },
          },
          required: ["id", "kind", "title"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "questions"],
    additionalProperties: false,
  },
};
