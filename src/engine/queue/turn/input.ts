import { autoRoutesNonVision, canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import { resolveImagesForNonVision } from "@/engine/tools/builtins/image/parse-image.ts";
import { imageRefMatches } from "@/kernel/std/paste/ref.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";

export interface PastedImageRef {
  id: number;
  data: string;
  mediaType: string;
  localPath?: string;
}

export function extractPastedImages(
  text: string,
  store: Pick<PasteStore, "get">,
): { pastedImages: PastedImageRef[]; imagePasteIds: number[] } {
  const pastedImages: PastedImageRef[] = [];
  const imagePasteIds: number[] = [];
  const seen = new Set<number>();
  for (const { id } of imageRefMatches(text)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stored = store.get(id);
    if (stored && stored.type === "image" && stored.mediaType) {
      pastedImages.push({
        id,
        data: stored.content,
        mediaType: stored.mediaType,
        ...(stored.sourcePath ? { localPath: stored.sourcePath } : {}),
      });
      imagePasteIds.push(id);
    }
  }
  return { pastedImages, imagePasteIds };
}

export async function resolveNonVisionImageBlocks(input: {
  blocks: ContentBlock[];
  text: string;
  turnState: {
    provider: ProviderId;
    model: string;
    effort: EffortLevel | null;
    permissionMode: PermissionMode;
  };
  session: { id: string; cwd: string };
  imageParserProvider: ProviderId | undefined;
}): Promise<ContentBlock[]> {
  const hasInlineImage = input.blocks.some((block) => block.type === "image");
  if (!hasInlineImage) {
    return input.blocks;
  }

  const activeProvider = input.turnState.provider;
  const activeModel = input.turnState.model;

  // 1. Provider can receive image blocks → passthrough (images stay)
  if (canSendNatively(activeProvider, activeModel)) {
    return input.blocks;
  }

  // 2. autoRoutesNonVision(activeProvider) → auto-route to nativeVisionModel(activeProvider)
  if (autoRoutesNonVision(activeProvider)) {
    const orderedPasteIds = imageRefMatches(input.text).map((m) => m.id);
    return resolveImagesForNonVision(
      input.blocks,
      {
        provider: activeProvider,
        model: activeModel,
        effort: input.turnState.effort,
        permissionMode: input.turnState.permissionMode,
        sessionId: input.session.id,
        cwd: input.session.cwd,
      },
      activeProvider,
      orderedPasteIds,
    );
  }

  // 3. else (not auto-route AND not native-vision, e.g. deepseek) → if cfg.imageParserProvider set → route via parserVisionModel(cfg.imageParserProvider); else → redact.
  if (input.imageParserProvider) {
    const orderedPasteIds = imageRefMatches(input.text).map((m) => m.id);
    return resolveImagesForNonVision(
      input.blocks,
      {
        provider: activeProvider,
        model: activeModel,
        effort: input.turnState.effort,
        permissionMode: input.turnState.permissionMode,
        sessionId: input.session.id,
        cwd: input.session.cwd,
      },
      input.imageParserProvider,
      orderedPasteIds,
    );
  }

  // Redact
  const placeholder =
    "[image redacted: active model cannot read images and no vision parser is configured.]";
  return input.blocks.map((block) => {
    if (block.type === "image") {
      return { type: "text", text: placeholder };
    }
    return block;
  });
}
