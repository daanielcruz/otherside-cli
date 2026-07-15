import { isAbsolute, resolve } from "node:path";
import { gatherPluginLspServerSpecs } from "@/engine/plugins/lsp.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import LSPSchema from "@/harness/tools/LSP/tool.json" with { type: "json" };
import { ensureFileOpen, getServer, specForFile } from "@/kernel/lsp/client.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  operation?: unknown;
  filePath?: unknown;
  line?: unknown;
  character?: unknown;
}

const VALID_OPS = new Set([
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
]);

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
}

export const LSP: ToolHandler = {
  schema: {
    name: LSPSchema.name,
    description: LSPSchema.description,
    inputSchema: LSPSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const operation = typeof args.operation === "string" ? args.operation : null;
    if (!operation || !VALID_OPS.has(operation)) {
      return err(call.id, `\`operation\` must be one of: ${[...VALID_OPS].join(", ")}`);
    }
    const fpRaw = typeof args.filePath === "string" ? args.filePath : null;
    if (!fpRaw) return err(call.id, "`filePath` is required");
    const line = typeof args.line === "number" ? args.line : 0;
    const character = typeof args.character === "number" ? args.character : 0;
    if (line < 1) return err(call.id, "`line` must be a positive integer");
    if (character < 1) return err(call.id, "`character` must be a positive integer");

    const filePath = isAbsolute(fpRaw) ? fpRaw : resolve(ctx.cwd, fpRaw);
    const spec = specForFile(filePath, gatherPluginLspServerSpecs());
    if (!spec) {
      return err(call.id, `no LSP server registered for ${filePath} (extension not supported)`);
    }
    const server = await getServer(spec, ctx.cwd);
    if (!server) {
      return err(call.id, `LSP server \`${spec.command}\` not installed. Install it and retry.`);
    }
    const uri = await ensureFileOpen(server, filePath);
    const position = { line: line - 1, character: character - 1 };
    const textDocument = { uri };

    try {
      let raw: unknown;
      switch (operation) {
        case "goToDefinition":
          raw = await server.request("textDocument/definition", { textDocument, position });
          break;
        case "findReferences":
          raw = await server.request("textDocument/references", {
            textDocument,
            position,
            context: { includeDeclaration: true },
          });
          break;
        case "hover":
          raw = await server.request("textDocument/hover", { textDocument, position });
          break;
        case "documentSymbol":
          raw = await server.request("textDocument/documentSymbol", { textDocument });
          break;
        case "workspaceSymbol":
          raw = await server.request("workspace/symbol", { query: "" });
          break;
        case "goToImplementation":
          raw = await server.request("textDocument/implementation", { textDocument, position });
          break;
        case "prepareCallHierarchy":
          raw = await server.request("textDocument/prepareCallHierarchy", {
            textDocument,
            position,
          });
          break;
        case "incomingCalls": {
          const items = (await server.request("textDocument/prepareCallHierarchy", {
            textDocument,
            position,
          })) as unknown[] | null;
          const item = Array.isArray(items) ? items[0] : null;
          raw = item ? await server.request("callHierarchy/incomingCalls", { item }) : null;
          break;
        }
        case "outgoingCalls": {
          const items = (await server.request("textDocument/prepareCallHierarchy", {
            textDocument,
            position,
          })) as unknown[] | null;
          const item = Array.isArray(items) ? items[0] : null;
          raw = item ? await server.request("callHierarchy/outgoingCalls", { item }) : null;
          break;
        }
      }

      const result = formatLspResult(operation, raw);
      return ok(call.id, {
        operation,
        filePath,
        line,
        character,
        result,
      });
    } catch (e) {
      return err(call.id, `LSP \`${operation}\` failed: ${(e as Error).message}`);
    }
  },
};

function formatLspResult(operation: string, raw: unknown): unknown {
  if (raw === null || raw === undefined) return { count: 0, items: [] };
  if (operation === "hover") {
    const obj = raw as { contents?: unknown };
    const contents = obj?.contents;
    if (typeof contents === "string") return { text: contents };
    if (Array.isArray(contents)) return { text: contents.map(formatHoverChunk).join("\n") };
    if (contents && typeof contents === "object") return { text: formatHoverChunk(contents) };
    return { text: "" };
  }
  if (Array.isArray(raw)) return { count: raw.length, items: raw };
  return { items: [raw] };
}

function formatHoverChunk(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as { value?: unknown; language?: unknown };
    if (typeof obj.value === "string") return obj.value;
  }
  return "";
}
