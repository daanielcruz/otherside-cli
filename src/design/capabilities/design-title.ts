import { notify } from "@/design/bridge/envelope.ts";
import { executeOneShotCompletion } from "@/design/capabilities/one-shot-completion.ts";
import { loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type { RpcContext } from "@/design/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const PLACEHOLDER_DESIGN_TITLES: ReadonlySet<string> = new Set(["", "Untitled", "Untitled design"]);

export async function generateAndSaveDesignTitle(
  ctx: RpcContext,
  requestContext: RequestContext,
  designId: string,
  userPrompt: string,
): Promise<void> {
  try {
    const systemPrompt =
      "Generate a short title of 2 to 5 words for the user's project based on their prompt. Output only the title, with no quotes, no markdown, and no leading/trailing punctuation.";
    const titleText = await executeOneShotCompletion(
      requestContext,
      systemPrompt,
      userPrompt,
      50,
      0.7,
    );

    const title = titleText
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (title.length > 0) {
      const snapshot = ctx.snapshots.get(designId) ?? loadDesignSnapshot(ctx.cwd, designId);
      // The snapshot ships a placeholder title, so a bare truthy check never fires;
      // treat the placeholders as "no real title yet" so generation can land.
      if (snapshot && PLACEHOLDER_DESIGN_TITLES.has(snapshot.title ?? "")) {
        snapshot.title = title;
        // Mark the title as machine-generated so the web can render it with a
        // distinct treatment until the user renames it.
        snapshot.titleIsAuto = true;
        snapshot.updatedAt = new Date().toISOString();
        ctx.snapshots.set(designId, snapshot);
        saveDesignSnapshot(ctx.cwd, snapshot);
        ctx.emit(notify("$/project-mutated", { title, isAutoTitle: true }));
      }
    }
  } catch {
    // Silent fail
  }
}

export function isPlaceholderDesignTitle(title: string | undefined): boolean {
  return PLACEHOLDER_DESIGN_TITLES.has(title ?? "");
}
