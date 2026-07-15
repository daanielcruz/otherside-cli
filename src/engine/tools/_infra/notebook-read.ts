import { existsSync, readFileSync } from "node:fs";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";

const LARGE_OUTPUT_THRESHOLD = 10000;

interface RawOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface RawCell {
  id?: string;
  cell_type?: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: RawOutput[];
}

interface RawNotebook {
  cells?: RawCell[];
  metadata?: { language_info?: { name?: string } };
}

interface OutputImage {
  image_data: string;
  media_type: ImageMediaType;
}

interface ProcessedOutput {
  text: string;
  image?: OutputImage;
}

interface ProcessedCell {
  cellType: string;
  source: string;
  language?: string;
  cellId: string;
  outputs?: ProcessedOutput[];
}

export interface NotebookReadResult {
  blocks: ToolResultContentBlock[];
  cellCount: number;
  serialized: string;
}

function joinSource(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join("");
  return source ?? "";
}

function normalizeOutputText(text: string | string[] | undefined): string {
  if (!text) return "";
  return Array.isArray(text) ? text.join("") : text;
}

function extractImage(data: Record<string, unknown>): OutputImage | undefined {
  const png = data["image/png"];
  if (typeof png === "string") {
    return { image_data: png.replace(/\s/g, ""), media_type: "image/png" };
  }
  const jpeg = data["image/jpeg"];
  if (typeof jpeg === "string") {
    return { image_data: jpeg.replace(/\s/g, ""), media_type: "image/jpeg" };
  }
  return undefined;
}

function normalizeOutput(output: RawOutput): ProcessedOutput | null {
  if (output.output_type === "stream") {
    return { text: normalizeOutputText(output.text) };
  }
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const data = output.data ?? {};
    const plain = data["text/plain"];
    const text = normalizeOutputText(plain as string | string[] | undefined);
    const image = extractImage(data);
    return image ? { text, image } : { text };
  }
  if (output.output_type === "error") {
    const traceback = Array.isArray(output.traceback) ? output.traceback.join("\n") : "";
    return { text: normalizeOutputText(`${output.ename}: ${output.evalue}\n${traceback}`) };
  }
  return null;
}

function isLargeOutputs(outputs: ProcessedOutput[]): boolean {
  let size = 0;
  for (const output of outputs) {
    size += output.text.length + (output.image?.image_data.length ?? 0);
    if (size > LARGE_OUTPUT_THRESHOLD) return true;
  }
  return false;
}

function formatCellMarkdown(
  cell: RawCell,
  index: number,
  codeLanguage: string,
  notebookPath: string,
): ProcessedCell {
  const cellType = cell.cell_type ?? "code";
  const processed: ProcessedCell = {
    cellType,
    source: joinSource(cell.source),
    cellId: cell.id ?? `cell-${index}`,
  };
  if (cellType === "code") processed.language = codeLanguage;

  if (cellType === "code" && cell.outputs && cell.outputs.length > 0) {
    const outputs = cell.outputs
      .map(normalizeOutput)
      .filter((output): output is ProcessedOutput => output !== null);
    if (isLargeOutputs(outputs)) {
      processed.outputs = [
        {
          text: `Outputs are too large to include. Use Bash with: cat "${notebookPath}" | jq '.cells[${index}].outputs'`,
        },
      ];
    } else {
      processed.outputs = outputs;
    }
  }

  return processed;
}

function cellContentBlock(cell: ProcessedCell): ToolResultContentBlock {
  const metadata: string[] = [];
  if (cell.cellType !== "code") metadata.push(`<cell_type>${cell.cellType}</cell_type>`);
  if (cell.cellType === "code" && cell.language !== "python") {
    metadata.push(`<language>${cell.language}</language>`);
  }
  const text = `<cell id="${cell.cellId}">${metadata.join("")}${cell.source}</cell id="${cell.cellId}">`;
  return { type: "text", text };
}

function cellOutputBlocks(output: ProcessedOutput): ToolResultContentBlock[] {
  const blocks: ToolResultContentBlock[] = [];
  if (output.text) blocks.push({ type: "text", text: `\n${output.text}` });
  if (output.image) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: output.image.media_type,
        data: output.image.image_data,
      },
    });
  }
  return blocks;
}

function blocksForCell(cell: ProcessedCell): ToolResultContentBlock[] {
  const outputBlocks = (cell.outputs ?? []).flatMap(cellOutputBlocks);
  return [cellContentBlock(cell), ...outputBlocks];
}

function mergeAdjacentText(blocks: ToolResultContentBlock[]): ToolResultContentBlock[] {
  const merged: ToolResultContentBlock[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === "text" && block.type === "text") {
      prev.text += `\n${block.text}`;
      continue;
    }
    merged.push(block);
  }
  return merged;
}

export function readNotebookBlocks(notebookPath: string): NotebookReadResult | string {
  if (!existsSync(notebookPath)) return `notebook does not exist: ${notebookPath}`;
  let raw: string;
  try {
    raw = readFileSync(notebookPath, "utf8");
  } catch (err) {
    return `failed to read ${notebookPath}: ${(err as Error).message}`;
  }
  let parsed: RawNotebook;
  try {
    parsed = JSON.parse(raw) as RawNotebook;
  } catch (err) {
    return `invalid notebook JSON at ${notebookPath}: ${(err as Error).message}`;
  }
  if (!parsed || !Array.isArray(parsed.cells)) {
    return `notebook missing \`cells\` array at ${notebookPath}`;
  }
  const language = parsed.metadata?.language_info?.name ?? "python";
  const cells = parsed.cells.map((cell, index) =>
    formatCellMarkdown(cell, index, language, notebookPath),
  );
  const blocks = mergeAdjacentText(cells.flatMap(blocksForCell));
  return { blocks, cellCount: cells.length, serialized: JSON.stringify(cells) };
}
