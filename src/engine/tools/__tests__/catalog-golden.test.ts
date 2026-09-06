import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { clear as clearPlugins } from "@/engine/plugins/registry.ts";
import {
  BASE_TOOL_NAMES,
  baseSchemas,
  deferredSchemas,
  deferredToolNames,
} from "@/engine/tools/index.ts";
import { setMcpClientSpawnerForTests } from "@/kernel/mcp/client/registry.ts";
import { clientFor, closeAllClients, type McpClient } from "@/kernel/mcp/index.ts";

// Wire-safe baseline (ROADMAP NOW #0) for the TOOL CATALOG. The ordered tool set
// — names, order, and per-tool input schema — is a wire fact: tools[] order keys
// the prompt cache, and a dropped/renamed tool changes the surface the model sees.
// `wire-facts.snapshot.test.ts` only checks `hasTools: true`; this golden pins the
// actual catalog so the #3 deterministic-catalog refactor (which rebuilds how these
// arrays are produced) is provably behaviour-preserving: a truly derive-only change
// leaves this snapshot untouched. Schemas are hashed to keep the snapshot compact
// while still catching any input-schema drift.

function schemaHash(inputSchema: unknown): string {
  return createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex").slice(0, 16);
}

function catalogShape(
  names: readonly string[],
  schemas: readonly { name: string; inputSchema: unknown }[],
): Array<{ name: string; schema: string }> {
  return schemas.map((schema, index) => {
    if (names[index] !== schema.name) {
      throw new Error(`catalog drift: name[${index}]=${names[index]} schema.name=${schema.name}`);
    }
    return { name: schema.name, schema: schemaHash(schema.inputSchema) };
  });
}

const RESOURCE_CAPABLE_MCP_CLIENT: McpClient = {
  async listTools() {
    return [];
  },
  async callTool() {
    return null;
  },
  async listResources() {
    return [];
  },
  async readResource() {
    return null;
  },
  async listDirectory() {
    return { resources: [] };
  },
  serverCapabilities() {
    return { resources: {} };
  },
  serverInstructions() {
    return null;
  },
  async listPrompts() {
    return [];
  },
  async getPrompt() {
    return { messages: [] };
  },
  announce(): void {},
  isClosed() {
    return false;
  },
  close() {},
};

describe("tool catalog golden (gates #3 deterministic catalog)", () => {
  beforeEach(async () => {
    clearPlugins();
    await closeAllClients();
    setMcpClientSpawnerForTests(async () => RESOURCE_CAPABLE_MCP_CLIENT);
    await clientFor("catalog-golden", {
      type: "stdio",
      command: "mcp-server",
      args: [],
    });
  });

  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
  });

  it("base tools — names, order, schema", () => {
    expect(catalogShape(BASE_TOOL_NAMES, baseSchemas)).toMatchSnapshot();
  });

  it("deferred tools — names, order, schema", () => {
    expect(catalogShape(deferredToolNames(), deferredSchemas())).toMatchSnapshot();
  });
});
