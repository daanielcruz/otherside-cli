export interface RawToolDecl {
  name: string;
  description: string | undefined;
  parameters: unknown;
}

export function readRawToolDecl(tool: unknown): RawToolDecl | null {
  if (!tool || typeof tool !== "object") return null;
  const obj = tool as Record<string, unknown>;
  const fn = (obj.function ?? obj) as Record<string, unknown>;
  const name = firstString(fn.name, obj.name);
  if (!name) return null;
  return {
    name,
    description: firstString(fn.description, obj.description),
    parameters: fn.parameters ??
      obj.parameters ??
      fn.input_schema ??
      obj.input_schema ?? {
        type: "object",
        properties: {},
      },
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}
