import {
  compileOutputSchema,
  STRUCTURED_OUTPUT_SUCCESS,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@/engine/background/subagents/structured-output.ts";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import type { StructuredOutputState } from "./types.ts";

export const STRUCTURED_OUTPUT_NUDGE_MESSAGE = `You did not call ${STRUCTURED_OUTPUT_TOOL_NAME}. You MUST call ${STRUCTURED_OUTPUT_TOOL_NAME} to return your answer — the tool input IS your answer. Call it now.`;

function cloneJsonBoundaryValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as unknown;
  }
}

export function structuredRetryMessage(state: StructuredOutputState, maxRetries: number): string {
  const detail = state.lastError !== null ? ` — last schema error: ${state.lastError}` : "";
  return `Reached maximum StructuredOutput retries (${maxRetries})${detail}`;
}

export function createStructuredOutputState(schema: Record<string, unknown>): {
  state: StructuredOutputState | null;
  error: string | null;
} {
  const compiled = compileOutputSchema(schema);
  if (compiled.kind === "invalid") return { state: null, error: compiled.error };
  return {
    state: {
      schema,
      validate: compiled.validate,
      consumed: false,
      value: undefined,
      retries: 0,
      lastError: null,
      lastInput: undefined,
    },
    error: null,
  };
}

export function acceptStructuredOutput(
  state: StructuredOutputState,
  input: unknown,
): { ok: true } | { ok: false; error: string } {
  const validation = state.validate(input);
  if (validation.kind === "mismatch") {
    state.retries += 1;
    state.lastError = validation.error;
    return { ok: false, error: validation.error };
  }
  state.value = cloneJsonBoundaryValue(input);
  state.consumed = true;
  return { ok: true };
}

function structuredOutputDeclaration(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    input_schema: schema,
  };
}

function withStructuredOutputDeclaration(
  tools: unknown[],
  schema: Record<string, unknown>,
): unknown[] {
  let found = false;
  const next = tools.map((tool) => {
    if (!isRecord(tool) || tool.name !== STRUCTURED_OUTPUT_TOOL_NAME) return tool;
    found = true;
    return {
      ...tool,
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      input_schema: schema,
    };
  });
  if (!found) next.push(structuredOutputDeclaration(schema));
  return next;
}

export function installStructuredOutputProvider(
  providerId: ProviderId | null,
  schema: Record<string, unknown>,
): () => void {
  if (providerId === null) return () => {};
  const base = providers.get(providerId);
  const wrapped: Provider = {
    ...base,
    translateRequest: (ctx, messages, tools) =>
      base.translateRequest(ctx, messages, withStructuredOutputDeclaration(tools, schema)),
  };
  providers.register(wrapped);
  return () => providers.register(base);
}

export function installStructuredOutputTool(state: StructuredOutputState): () => void {
  const previous = toolRegistry.get(STRUCTURED_OUTPUT_TOOL_NAME);
  const previousNamespace = toolRegistry.getNamespace(STRUCTURED_OUTPUT_TOOL_NAME);
  const handler: ToolHandler = {
    schema: {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      inputSchema: state.schema,
    },
    async run(call) {
      const accepted = acceptStructuredOutput(state, call.input ?? {});
      if (!accepted.ok) {
        return { tool_use_id: call.id, content: accepted.error, is_error: true };
      }
      return { tool_use_id: call.id, content: STRUCTURED_OUTPUT_SUCCESS };
    },
  };
  toolRegistry.register(handler);
  return () => {
    toolRegistry.unregister(STRUCTURED_OUTPUT_TOOL_NAME);
    if (previous === undefined) return;
    if (previousNamespace !== undefined)
      toolRegistry.registerWithNamespace(previousNamespace, previous);
    else toolRegistry.register(previous);
  };
}
