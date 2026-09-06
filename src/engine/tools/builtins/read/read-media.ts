import { statSync } from "node:fs";
import { basename } from "node:path";
import { nativeVisionModel } from "@/engine/model/facts/capabilities.ts";
import { canSendNatively, canSendPdfNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import {
  inspectPdf,
  isPdftoppmAvailable,
  PDF_INLINE_PAGE_THRESHOLD,
  PDF_MAX_NATIVE_SIZE,
  PDF_MAX_PAGES_PER_READ,
  type PdfPageRange,
  parsePdfPageRange,
  renderPdfPages,
} from "@/engine/tools/_infra/pdf-read.ts";
import {
  describeImageViaProvider,
  type LoadedImage,
  loadImageFromDisk,
} from "@/engine/tools/builtins/image/parse-image.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import { getActivePasteStore } from "@/kernel/std/paste/registry.ts";
import type { ToolCall, ToolResult, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { readScopeKey, readSetInsert } from "./state.ts";

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

export async function readImageBranch(
  call: ToolCall,
  ctx: RequestContext,
  filePath: string,
): Promise<ToolResult> {
  const providerSupportsImages = canSendNatively(ctx.provider, ctx.model);

  let limitBytes = 20 * 1024 * 1024;
  let parserProvider = ctx.provider;
  if (!providerSupportsImages) {
    const cfg = await loadConfig();
    if (!nativeVisionModel(parserProvider) && !canSendNatively(parserProvider)) {
      if (cfg.imageParserProvider) {
        parserProvider = cfg.imageParserProvider as ProviderId;
      }
    }
    if (parserProvider === "glm") {
      limitBytes = 5 * 1024 * 1024;
    }
  }

  const image = loadImageFromDisk(filePath, limitBytes);
  if (typeof image === "string") return err(call.id, image);

  const store = getActivePasteStore();
  if (store) {
    store.add({
      type: "image",
      content: image.data,
      mediaType: image.mediaType,
      sourcePath: filePath,
    });
  }

  const imageBytes = statSync(filePath).size;

  if (providerSupportsImages) {
    return {
      tool_use_id: call.id,
      content: [imageContentBlock(image)],
      meta: { kind: "image", bytes: imageBytes },
    };
  }

  const result = await describeImageViaProvider(ctx, image, "");
  if ("error" in result) return err(call.id, result.error);

  return {
    tool_use_id: call.id,
    content: result.text,
    meta: {
      kind: "image",
      bytes: imageBytes,
      visionModel: result.visionModel,
    },
  };
}

function imageContentBlock(image: LoadedImage): ToolResultContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType,
      data: image.data,
    },
  };
}

type PdfRangeValidation = { ok: true; range: PdfPageRange } | { ok: false; error: ToolResult };

function validatePdfRange(toolUseId: string, pages: string): PdfRangeValidation {
  const range = parsePdfPageRange(pages);
  if (!range) {
    return {
      ok: false,
      error: err(
        toolUseId,
        `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
      ),
    };
  }
  const rangeSize =
    range.lastPage === Number.POSITIVE_INFINITY
      ? PDF_MAX_PAGES_PER_READ + 1
      : range.lastPage - range.firstPage + 1;
  if (rangeSize > PDF_MAX_PAGES_PER_READ) {
    return {
      ok: false,
      error: err(
        toolUseId,
        `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
      ),
    };
  }
  return { ok: true, range };
}

export function readPdfBranch(
  call: ToolCall,
  ctx: RequestContext,
  filePath: string,
  pages: string | null,
): ToolResult {
  const inspected = inspectPdf(filePath);
  if (!inspected.ok) return err(call.id, inspected.error);

  let range: PdfPageRange | undefined;
  if (pages) {
    const validated = validatePdfRange(call.id, pages);
    if (!validated.ok) return validated.error;
    range = validated.range;
    if (range.firstPage > inspected.pageCount || range.lastPage > inspected.pageCount) {
      return err(
        call.id,
        `Page range "${pages}" is outside this PDF's ${inspected.pageCount} pages.`,
      );
    }
  }

  const supportsNativePdf = canSendPdfNatively(ctx.provider, ctx.model);
  if (!range && inspected.pageCount > PDF_INLINE_PAGE_THRESHOLD) {
    return err(
      call.id,
      `This PDF has ${inspected.pageCount} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
    );
  }
  if (!range && supportsNativePdf && inspected.bytes > PDF_MAX_NATIVE_SIZE) {
    return err(call.id, `PDF file exceeds maximum allowed size of ${PDF_MAX_NATIVE_SIZE} bytes.`);
  }
  if (!range && supportsNativePdf) {
    readSetInsert(readScopeKey(ctx), filePath, "");
    return {
      tool_use_id: call.id,
      content: [
        { type: "text", text: `[PDF] ${filePath} — ${inspected.pageCount} page(s)` },
        {
          type: "pdf",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: inspected.data.toString("base64"),
          },
          filename: basename(filePath),
          pageCount: inspected.pageCount,
          bytes: inspected.bytes,
        },
      ],
    };
  }
  if (!canSendNatively(ctx.provider, ctx.model)) {
    return err(
      call.id,
      `Reading PDFs requires a vision-capable provider; \`${ctx.provider}\` cannot render PDF pages.`,
    );
  }
  if (!isPdftoppmAvailable()) {
    return err(
      call.id,
      "Reading PDFs requires poppler-utils (pdftoppm). Install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.",
    );
  }

  const rendered = renderPdfPages(filePath, range);
  if ("error" in rendered) return err(call.id, rendered.error);

  const header = `[PDF] ${filePath} — ${rendered.pages.length} page(s) rendered`;
  const content: ToolResultContentBlock[] = [{ type: "text", text: header }];
  for (const page of rendered.pages) {
    content.push(imageContentBlock({ data: page.toString("base64"), mediaType: "image/jpeg" }));
  }
  readSetInsert(readScopeKey(ctx), filePath, "");
  return { tool_use_id: call.id, content };
}
