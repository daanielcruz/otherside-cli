import { describe, expect, test } from "bun:test";
import {
  geminiSanitizeSchema,
  geminiToolsToFunctionDeclarations,
} from "@/engine/providers/_shared/gemini-wire.ts";
import agentTool from "@/harness/tools/Agent/tool.json" with { type: "json" };

describe("geminiSanitizeSchema", () => {
  test("coerces integer enum values to strings", () => {
    const result = geminiSanitizeSchema({
      type: "integer",
      enum: [1, 2, 3],
    }) as Record<string, unknown>;

    expect(result.enum).toEqual(["1", "2", "3"]);
  });

  test("leaves string enums unchanged", () => {
    const result = geminiSanitizeSchema({
      type: "string",
      enum: ["general", "warrior", "scout"],
    }) as Record<string, unknown>;

    expect(result.enum).toEqual(["general", "warrior", "scout"]);
  });

  test("coerces enums nested in properties", () => {
    const result = geminiSanitizeSchema({
      type: "object",
      properties: {
        level: {
          type: "integer",
          enum: [1, 2, 3],
        },
      },
    }) as Record<string, unknown>;

    const properties = result.properties as Record<string, Record<string, unknown>>;
    expect(properties.level!.enum).toEqual(["1", "2", "3"]);
  });
});

describe("geminiToolsToFunctionDeclarations", () => {
  test("emits string enum values for the Agent tier schema", () => {
    const result = geminiToolsToFunctionDeclarations([
      {
        name: agentTool.name,
        description: agentTool.description.preamble,
        input_schema: agentTool.inputSchema,
      },
    ]);

    expect(result).toHaveLength(1);
    const decls = (result[0] as Record<string, unknown>).functionDeclarations as Array<
      Record<string, unknown>
    >;
    expect(decls).toHaveLength(1);

    const parameters = decls[0]!.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.tier!.enum).toEqual(["general", "warrior", "scout"]);
  });
});
