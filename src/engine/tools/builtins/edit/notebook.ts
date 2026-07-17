import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import NotebookEditSchema from "@/harness/tools/NotebookEdit/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  recordFileMutationResult,
  snapshotBeforeFileMutation,
} from "@/kernel/storage/file-history.ts";
import { isNetworkSharePath, NETWORK_SHARE_PATH_ERROR } from "../path-guards.ts";

type CellType = "code" | "markdown";
type EditMode = "replace" | "insert" | "delete";

interface NotebookCell {
  id?: string;
  cell_type: CellType;
  source: string | string[];
  execution_count?: number | null;
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
}

interface Notebook {
  cells: NotebookCell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: Record<string, unknown>;
}

interface ParsedInput {
  notebookPath: string;
  cellId: string | null;
  newSource: string;
  cellType: CellType | null;
  editMode: EditMode;
}

function parseInput(raw: unknown): ParsedInput | string {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const notebookPath = typeof obj.notebook_path === "string" ? obj.notebook_path : null;
  if (!notebookPath) return "`notebook_path` is required (absolute path to the .ipynb file)";
  if (!isAbsolute(notebookPath)) return `\`notebook_path\` must be absolute: ${notebookPath}`;
  if (isNetworkSharePath(notebookPath)) return NETWORK_SHARE_PATH_ERROR;
  if (!notebookPath.endsWith(".ipynb")) return "`notebook_path` must end with .ipynb";
  const editModeRaw = typeof obj.edit_mode === "string" ? obj.edit_mode : "replace";
  if (editModeRaw !== "replace" && editModeRaw !== "insert" && editModeRaw !== "delete") {
    return `\`edit_mode\` must be one of replace|insert|delete (got ${editModeRaw})`;
  }
  const cellId = typeof obj.cell_id === "string" && obj.cell_id.length > 0 ? obj.cell_id : null;
  const newSource = typeof obj.new_source === "string" ? obj.new_source : "";
  const cellTypeRaw = typeof obj.cell_type === "string" ? obj.cell_type : null;
  const cellType =
    cellTypeRaw === "code" || cellTypeRaw === "markdown" ? (cellTypeRaw as CellType) : null;
  if (editModeRaw === "delete") {
    if (!cellId) return "`cell_id` is required for edit_mode: delete";
    return { notebookPath, cellId, newSource, cellType, editMode: editModeRaw };
  }
  if (editModeRaw === "replace") {
    if (!cellId) return "`cell_id` is required for edit_mode: replace";
    if (typeof obj.new_source !== "string")
      return "`new_source` is required for edit_mode: replace";
    return { notebookPath, cellId, newSource, cellType, editMode: editModeRaw };
  }
  if (typeof obj.new_source !== "string") return "`new_source` is required for edit_mode: insert";
  return { notebookPath, cellId, newSource, cellType, editMode: editModeRaw };
}

function loadNotebook(path: string): Notebook | string {
  if (!existsSync(path)) return `notebook does not exist: ${path}`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return `failed to read ${path}: ${(err as Error).message}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `invalid notebook JSON at ${path}: ${(err as Error).message}`;
  }
  const obj = parsed as Notebook;
  if (!obj || !Array.isArray(obj.cells)) {
    return `notebook missing \`cells\` array at ${path}`;
  }
  return obj;
}

function generateCellId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function applyReplace(
  notebook: Notebook,
  cellId: string,
  newSource: string,
  cellType: CellType | null,
): string | null {
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return `cell_id not found: ${cellId}`;
  const current = notebook.cells[idx]!;
  if (cellType && cellType !== current.cell_type) {
    return `cell_type mismatch: cell ${cellId} is ${current.cell_type}, refusing to convert to ${cellType}`;
  }
  current.source = newSource;
  if (current.cell_type === "code") {
    current.execution_count = null;
    current.outputs = [];
  }
  return null;
}

function applyInsert(
  notebook: Notebook,
  cellId: string | null,
  newSource: string,
  cellType: CellType | null,
): string | null {
  const type: CellType = cellType ?? "code";
  const fresh: NotebookCell = {
    id: generateCellId(),
    cell_type: type,
    source: newSource,
    metadata: {},
    ...(type === "code" ? { execution_count: null, outputs: [] } : {}),
  };
  if (!cellId) {
    notebook.cells.unshift(fresh);
    return null;
  }
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return `cell_id not found: ${cellId}`;
  notebook.cells.splice(idx + 1, 0, fresh);
  return null;
}

function applyDelete(notebook: Notebook, cellId: string): string | null {
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return `cell_id not found: ${cellId}`;
  notebook.cells.splice(idx, 1);
  return null;
}

function persistNotebook(path: string, notebook: Notebook): string | null {
  try {
    writeFileSync(path, `${JSON.stringify(notebook, null, 1)}\n`, "utf8");
    return null;
  } catch (err) {
    return `failed to write ${path}: ${(err as Error).message}`;
  }
}

export const NotebookEdit: ToolHandler = {
  schema: NotebookEditSchema,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const parsed = parseInput(call.input);
    if (typeof parsed === "string") {
      return { tool_use_id: call.id, content: parsed, is_error: true };
    }
    const notebook = loadNotebook(parsed.notebookPath);
    if (typeof notebook === "string") {
      return { tool_use_id: call.id, content: notebook, is_error: true };
    }
    await snapshotBeforeFileMutation(ctx, parsed.notebookPath);
    const APPLY: Record<EditMode, () => string | null> = {
      replace: () => applyReplace(notebook, parsed.cellId!, parsed.newSource, parsed.cellType),
      insert: () => applyInsert(notebook, parsed.cellId, parsed.newSource, parsed.cellType),
      delete: () => applyDelete(notebook, parsed.cellId!),
    };
    const applyError = APPLY[parsed.editMode]();
    if (applyError !== null) {
      return { tool_use_id: call.id, content: applyError, is_error: true };
    }
    const persistError = persistNotebook(parsed.notebookPath, notebook);
    if (persistError !== null) {
      return { tool_use_id: call.id, content: persistError, is_error: true };
    }
    recordFileMutationResult(ctx, parsed.notebookPath);
    const summary =
      parsed.editMode === "replace"
        ? `Replaced cell ${parsed.cellId} in ${parsed.notebookPath}`
        : parsed.editMode === "insert"
          ? parsed.cellId
            ? `Inserted new cell after ${parsed.cellId} in ${parsed.notebookPath}`
            : `Prepended new cell to ${parsed.notebookPath}`
          : `Deleted cell ${parsed.cellId} from ${parsed.notebookPath}`;
    return { tool_use_id: call.id, content: summary };
  },
};
