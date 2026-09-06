import { loadDesignSnapshot } from "@/design/storage.ts";
import type { DesignSnapshot, DesignSnapshotFile, RpcContext } from "@/design/types.ts";

const CANVAS_INLINE_CAP = 24000;

function activeScreenSource(
  snapshot: DesignSnapshot,
  screens: DesignSnapshotFile[],
): { path: string; content: string } | undefined {
  const active = snapshot.viewState.activeFileTab;
  const target =
    (active ? screens.find((file) => file.path === active) : undefined) ??
    (screens.length === 1 ? screens[0] : undefined);
  if (!target) return undefined;
  const artifact = snapshot.artifacts.find((entry) => entry.metadata?.path === target.path);
  const content = target.content ?? artifact?.content ?? "";
  return content.length > 0 ? { path: target.path, content } : undefined;
}

function activeSourceBlock(active: { path: string; content: string } | undefined): string[] {
  if (!active) return [];
  if (active.content.length > CANVAS_INLINE_CAP) {
    return [
      "",
      `Active screen "${active.path}" is ${active.content.length} bytes — too large to inline; call read_design({ path: "${active.path}" }) for its exact source before editing.`,
    ];
  }
  return [
    "",
    `Active screen "${active.path}" — current source (edit against THIS exact markup, never from memory):`,
    "```html",
    active.content,
    "```",
  ];
}

export function buildCanvasContext(snapshot: DesignSnapshot | undefined): string {
  if (!snapshot) return "";
  const screens = snapshot.files.filter((file) => file.path.endsWith(".html"));
  if (screens.length === 0) {
    return "The canvas is currently empty — no screens exist yet. Use create_design to add the first screen.\n\n";
  }
  const list = screens
    .map((file, index) => {
      const artifact = snapshot.artifacts.find((entry) => entry.metadata?.path === file.path);
      const bytes = (file.content ?? artifact?.content ?? "").length;
      const name = file.displayName ?? file.path;
      return `  ${index + 1}. ${file.path} — "${name}" (${bytes} bytes, ${file.status})`;
    })
    .join("\n");
  const activeBlock = activeSourceBlock(activeScreenSource(snapshot, screens));
  return [
    "Current canvas (already built — do not start over):",
    `${screens.length} screen(s) on the canvas:`,
    list,
    "Prior turns' tool activity is replayed in the conversation; use read_design for the current exact source before editing.",
    "Adjust an existing screen via update_design on its path; create_design only for a new screen.",
    "Read a screen's exact source with read_design before editing; a find/replace must match a snippet that appears exactly once.",
    ...activeBlock,
    "",
    "",
  ].join("\n");
}

export function resolveSnapshot(ctx: RpcContext, designId: string): DesignSnapshot | undefined {
  const inMemory = ctx.snapshots.get(designId);
  if (inMemory) return inMemory;
  const fromDisk = loadDesignSnapshot(ctx.cwd, designId);
  if (!fromDisk) return undefined;
  ctx.snapshots.set(designId, fromDisk);
  return fromDisk;
}
