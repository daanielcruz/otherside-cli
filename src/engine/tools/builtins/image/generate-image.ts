import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CodexImageInput,
  type CodexImageResult,
  generateImage,
  type ImageSize,
} from "@/engine/providers/codex/image.ts";
import { removeChromaKey } from "@/engine/tools/_infra/chroma-key.ts";
import { loadImageFromDisk } from "@/engine/tools/builtins/image/parse-image.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import GenerateImageSchema from "@/harness/tools/GenerateImage/tool.json" with { type: "json" };
import { loadConfig } from "@/kernel/config/config.ts";
import { imageCacheRoot } from "@/kernel/std/fs/paths.ts";
import { resizeImageIfTooLarge } from "@/kernel/std/image-resize.ts";
import { getActivePasteStore } from "@/kernel/std/paste/registry.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { hasCodexCredentialSync } from "@/kernel/storage/credentials.ts";

const VALID_SIZES = new Set<ImageSize>(["1024x1024", "1024x1536", "1536x1024"]);

interface Input {
  prompt?: unknown;
  size?: unknown;
  transparent?: unknown;
  referenced_image_paths?: unknown;
  num_last_images_to_include?: unknown;
}

const CHROMA_KEY_BACKDROP_HINT = [
  "",
  "Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.",
  "The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.",
  "Keep the subject fully separated from the background with crisp edges and generous padding.",
  "Do not use #00ff00 anywhere in the subject.",
  "No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.",
].join(" ");

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function flattenPromptHead(prompt: string, max: number): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const primary = lines.find((l) => /^primary request[:\s]/i.test(l));
  const head = primary
    ? primary.replace(/^primary request[:\s]+/i, "")
    : (lines[0] ?? prompt.trim());
  const arr = [...head];
  return arr.length <= max ? head : `${arr.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function persistPng(base64: string, callId: string): string {
  const root = imageCacheRoot();
  mkdirSync(root, { recursive: true });
  const filename = `gen-${Date.now()}-${sanitize(callId)}.png`;
  const path = join(root, filename);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 32) : "image";
}

function normalizePngSize(base64: string, size: ImageSize): string {
  const [width, height] = size.split("x").map(Number) as [number, number];
  const resized = resizeImageIfTooLarge(Buffer.from(base64, "base64"), "image/png", {
    maxWidth: width,
    maxHeight: height,
    targetRawSize: Number.POSITIVE_INFINITY,
  });
  return resized.buffer.toString("base64");
}

function inputImages(args: Input): { images: CodexImageInput[] } | { error: string } {
  const rawPaths = args.referenced_image_paths;
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
    return { error: "`referenced_image_paths` must be an array" };
  }
  const paths = (rawPaths ?? []) as unknown[];
  if (paths.length > 5) {
    return { error: "`referenced_image_paths` must contain at most 5 paths" };
  }
  if (paths.some((path) => typeof path !== "string")) {
    return { error: "`referenced_image_paths` must contain only absolute paths" };
  }

  const rawCount = args.num_last_images_to_include;
  if (
    rawCount !== undefined &&
    (!Number.isInteger(rawCount) || Number(rawCount) < 1 || Number(rawCount) > 5)
  ) {
    return { error: "`num_last_images_to_include` must be between 1 and 5" };
  }
  if (paths.length > 0 && rawCount !== undefined) {
    return {
      error: "provide only one of `referenced_image_paths` or `num_last_images_to_include`",
    };
  }

  if (paths.length > 0) {
    const images: CodexImageInput[] = [];
    for (const path of paths as string[]) {
      const loaded = loadImageFromDisk(path);
      if (typeof loaded === "string") {
        return { error: `unable to process referenced image at \`${path}\`: ${loaded}` };
      }
      images.push(loaded);
    }
    return { images };
  }

  if (rawCount !== undefined) {
    const count = Number(rawCount);
    const store = getActivePasteStore();
    const available = (store?.list() ?? []).filter(
      (item): item is typeof item & { mediaType: NonNullable<typeof item.mediaType> } =>
        item.type === "image" && typeof item.content === "string" && item.mediaType !== undefined,
    );
    const selected = available.slice(-count);
    if (selected.length !== count) {
      return {
        error: `requested the last ${count} conversation images, but only ${selected.length} were available`,
      };
    }
    return {
      images: selected.map((item) => ({ data: item.content, mediaType: item.mediaType })),
    };
  }

  return { images: [] };
}

export const GenerateImage: ToolHandler = {
  schema: GenerateImageSchema,
  render: {
    summarizeArgs(input) {
      const obj = (input ?? {}) as Record<string, unknown>;
      const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
      const size = typeof obj.size === "string" ? obj.size : "";
      const transparent = obj.transparent === true;
      const head = flattenPromptHead(prompt, 80);
      const tags = [transparent ? "transparent" : "", size].filter((t) => t.length > 0);
      return tags.length > 0 ? `${head} · ${tags.join(" · ")}` : head;
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (prompt.length < 3) {
      return err(call.id, "missing or too-short `prompt`");
    }
    const sizeRaw = typeof args.size === "string" ? args.size : "";
    const size: ImageSize = VALID_SIZES.has(sizeRaw as ImageSize)
      ? (sizeRaw as ImageSize)
      : "1024x1024";
    const transparent = args.transparent === true;
    const effectivePrompt = transparent ? `${prompt}${CHROMA_KEY_BACKDROP_HINT}` : prompt;

    const cfg = await loadConfig();
    if (ctx.provider !== "codex" && cfg.imageGen !== true) {
      return err(
        call.id,
        "image generation is disabled. Open /config and enable `Codex image gen`.",
      );
    }
    if (!hasCodexCredentialSync()) {
      return err(
        call.id,
        "image generation requires Codex credentials. Run `otherside login --provider codex`.",
      );
    }

    const resolvedImages = inputImages(args);
    if ("error" in resolvedImages) return err(call.id, resolvedImages.error);

    let result: CodexImageResult;
    try {
      result = await generateImage({
        prompt: effectivePrompt,
        size,
        images: resolvedImages.images,
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = raw.toLowerCase().startsWith("image generation")
        ? raw
        : `image generation failed: ${raw}`;
      return err(call.id, msg);
    }

    let finalBase64 = result.base64;
    if (transparent) {
      try {
        const sourcePng = Buffer.from(result.base64, "base64");
        const removed = removeChromaKey(sourcePng, {
          autoKey: "border",
          tolerance: 12,
          softMatte: true,
          transparentThreshold: 12,
          opaqueThreshold: 220,
          edgeContract: 0,
          edgeFeather: 0,
          spillCleanup: true,
        });
        finalBase64 = removed.png.toString("base64");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(call.id, `chroma-key removal failed: ${msg}`);
      }
    }

    try {
      finalBase64 = normalizePngSize(finalBase64, size);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(call.id, `could not resize generated image: ${msg}`);
    }

    let savedPath: string;
    try {
      savedPath = persistPng(finalBase64, result.callId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(call.id, `could not save generated image: ${msg}`);
    }

    const store = getActivePasteStore();
    if (store) {
      store.add({
        type: "image",
        content: finalBase64,
        mediaType: "image/png",
        sourcePath: savedPath,
      });
    }

    const homePath = savedPath.startsWith(`${homedir()}/`)
      ? `~/${savedPath.slice(homedir().length + 1)}`
      : savedPath;
    return { tool_use_id: call.id, content: homePath };
  },
};
