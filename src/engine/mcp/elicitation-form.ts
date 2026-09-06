import type { GroupAnswer, GroupQuestion } from "@/kernel/channels/ask.ts";

/**
 * The form a server asks for, as questions the reader can answer.
 *
 * The protocol keeps the schema flat — an object of primitives, no nesting — so
 * each property is one question, and what a value may be decides whether the
 * reader picks from a list or types it.
 */

interface FieldSchema {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  choices?: string[];
  required: boolean;
}

export interface FormFill {
  ok: boolean;
  content?: Record<string, unknown>;
  /** What the reader would have to change, when the answers do not satisfy the schema. */
  reason?: string;
}

/** The fields a schema declares, in the order it declares them. */
export function schemaFields(schema: Record<string, unknown> | undefined): FieldSchema[] {
  const properties = schema?.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((name): name is string => typeof name === "string")
      : [],
  );
  const fields: FieldSchema[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const property = raw as Record<string, unknown>;
    const type = fieldType(property.type);
    if (type === null) continue;
    const choices = enumChoices(property.enum);
    fields.push({
      name,
      type,
      ...(typeof property.title === "string" ? { title: property.title } : {}),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      ...(choices === null ? {} : { choices }),
      required: required.has(name),
    });
  }
  return fields;
}

/**
 * One question per field. A field with a fixed set of values is a choice; a
 * boolean is the same thing with two; anything else is typed, and an optional
 * field carries the way to leave it out.
 */
export function formQuestions(fields: readonly FieldSchema[]): GroupQuestion[] {
  return fields.map((field) => {
    const label = field.title ?? field.name;
    const description = field.description ?? "";
    const options =
      field.choices?.map((choice) => ({ label: choice, description })) ??
      (field.type === "boolean"
        ? [
            { label: "Yes", description },
            { label: "No", description },
          ]
        : []);
    return {
      question: field.required ? label : `${label} (optional)`,
      header: field.name,
      options: options.length > 0 ? options : [{ label: "Skip", description }],
      multiSelect: false,
      allowFreeform: field.choices === undefined && field.type !== "boolean",
    };
  });
}

/**
 * The answers as the object the server asked for, or the reason they are not it.
 * A required field left empty and a number that is not one both fail here rather
 * than on the wire, where the server would have to say so instead.
 */
export function formContent(
  fields: readonly FieldSchema[],
  questions: readonly GroupQuestion[],
  answers: readonly GroupAnswer[],
): FormFill {
  const byQuestion = new Map(answers.map((answer) => [answer.question, answer.answer]));
  const content: Record<string, unknown> = {};
  for (const [index, field] of fields.entries()) {
    const question = questions[index];
    const written = question === undefined ? undefined : byQuestion.get(question.question);
    const value = (written ?? "").trim();
    if (value.length === 0 || value === "Skip") {
      if (field.required) return { ok: false, reason: `${field.name} is required` };
      continue;
    }
    if (field.type === "boolean") {
      content[field.name] = value === "Yes" || value === "true";
      continue;
    }
    if (field.type === "string") {
      if (field.choices !== undefined && !field.choices.includes(value)) {
        return { ok: false, reason: `${field.name} must be one of ${field.choices.join(", ")}` };
      }
      content[field.name] = value;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return { ok: false, reason: `${field.name} must be a number` };
    if (field.type === "integer" && !Number.isInteger(parsed)) {
      return { ok: false, reason: `${field.name} must be a whole number` };
    }
    content[field.name] = parsed;
  }
  return { ok: true, content };
}

function fieldType(raw: unknown): FieldSchema["type"] | null {
  if (raw === "string" || raw === "number" || raw === "integer" || raw === "boolean") return raw;
  return null;
}

function enumChoices(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const choices = raw.filter((value): value is string => typeof value === "string");
  return choices.length > 0 ? choices : null;
}
