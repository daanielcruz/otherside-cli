// The aux one-shot paths (title, memory-selection, compaction summary, stop-hook
// classifier) post-process the wire body with the internal glm/anthropic-wire
// vocabulary — `max_tokens`, `thinking:{type:"disabled"}`, `output_config`. The
// xAI chat proxy validates strictly and 400s those, so translate them to the
// Responses dialect (or drop them) as the final step before the request goes out.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeGrokBody(body: unknown): unknown {
  const rec = asRecord(body);
  if (!rec) return body;
  const out: Record<string, unknown> = { ...rec };

  // Responses uses max_output_tokens; max_tokens is chat-completions only.
  if ("max_tokens" in out) {
    if (out.max_output_tokens === undefined && typeof out.max_tokens === "number") {
      out.max_output_tokens = out.max_tokens;
    }
    delete out.max_tokens;
  }

  // Reasoning is expressed via the `reasoning` object; a bare thinking flag is
  // meaningless to the Responses wire.
  delete out.thinking;

  // output_config.format → Responses structured output (text.format json_schema).
  const outputConfig = asRecord(out.output_config);
  if (outputConfig) {
    const format = asRecord(outputConfig.format);
    if (format?.schema) {
      const existingText = asRecord(out.text) ?? {};
      out.text = {
        ...existingText,
        format: {
          type: "json_schema",
          name: typeof format.name === "string" ? format.name : "response",
          strict: true,
          schema: format.schema,
        },
      };
    }
    delete out.output_config;
  }

  // An empty tools array (aux calls clear tools) with a dangling tool_choice is
  // rejected; drop both so the request carries no tool surface.
  if (Array.isArray(out.tools) && out.tools.length === 0) {
    delete out.tools;
    delete out.tool_choice;
  }

  return out;
}
