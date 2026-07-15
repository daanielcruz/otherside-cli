import { Ajv } from "ajv";

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return structured output in the requested format";

export const STRUCTURED_OUTPUT_FORCING_INSTRUCTION =
  "Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.";

export const STRUCTURED_OUTPUT_SUCCESS = "Structured output provided successfully";

export const STRUCTURED_OUTPUT_NUDGE_MESSAGE = `You did not call ${STRUCTURED_OUTPUT_TOOL_NAME}. You MUST call ${STRUCTURED_OUTPUT_TOOL_NAME} to return your answer — the tool input IS your answer. Call it now.`;

type SchemaValidation = { kind: "valid" } | { kind: "mismatch"; error: string };

type CompiledSchema =
  | { kind: "ok"; validate: (input: unknown) => SchemaValidation }
  | { kind: "invalid"; error: string };

const validatorCache = new WeakMap<object, CompiledSchema>();

export function compileOutputSchema(schema: object): CompiledSchema {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) return cached;

  let result: CompiledSchema;
  try {
    const ajv = new Ajv({ allErrors: true });
    if (!ajv.validateSchema(schema)) {
      result = { kind: "invalid", error: ajv.errorsText(ajv.errors) };
    } else {
      const validate = ajv.compile(schema);
      result = {
        kind: "ok",
        validate: (input: unknown): SchemaValidation => {
          if (validate(input)) return { kind: "valid" };
          const errors = (validate.errors ?? [])
            .map((e) => `${e.instancePath || "root"}: ${e.message}`)
            .join(", ");
          return {
            kind: "mismatch",
            error: `Output does not match required schema: ${errors}`,
          };
        },
      };
    }
  } catch (err) {
    result = { kind: "invalid", error: err instanceof Error ? err.message : String(err) };
  }

  validatorCache.set(schema, result);
  return result;
}
