import { transcriptActions } from "@/store/index.ts";
import type { OverlayName } from "@/store/overlay-stack/index.ts";
import { nextTranscriptId } from "@/store/turn-tracking/index.ts";

/**
 * The line a closed panel leaves behind.
 *
 * A panel takes the frame and gives it back, and without a trace the scrollback
 * reads as though it was never opened — the reader scrolling past finds a gap
 * between two turns and nothing that says what filled it.
 */

/** What a panel is called once it is gone. Absent means it leaves no line. */
const DISMISSED_AS: Partial<Record<OverlayName, string>> = {
  agents: "Agents",
  bashes: "Background shells",
  config: "Config",
  diff: "Diff",
  effort: "Effort",
  help: "Help",
  hooks: "Hooks",
  mcp: "MCP",
  model: "Model",
  orchestration: "Orchestration",
  permissions: "Permissions",
  plugins: "Plugins",
  rewind: "Rewind",
  skills: "Skills",
  stats: "Stats",
  status: "Status",
  tasks: "Background tasks",
  theme: "Theme",
  usage: "Usage",
  workflows: "Dynamic workflows",
};

export function dismissalText(name: OverlayName): string | null {
  const label = DISMISSED_AS[name];
  return label === undefined ? null : `${label} dialog dismissed`;
}

/**
 * Writes the line, if that panel leaves one. Muted, because it is a record of
 * what happened rather than something to read.
 */
export function noteDismissal(name: OverlayName): void {
  const text = dismissalText(name);
  if (text === null) return;
  transcriptActions.update((entries) => [
    ...entries,
    { id: nextTranscriptId("panel_dismissed"), kind: "compact_done", text, muted: true },
  ]);
}
