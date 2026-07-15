import type { Color as InkColor } from "@/ink";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export const BULLET_IDLE = Glyph.bulletHollow;
export const BULLET_VIEWED = Glyph.bullet;
export const TICK = Glyph.check;
export const CROSS = "✘";
export const PAUSE_GLYPH = "☰";
export const CIRCLE_DOTTED = "◌";
export const SPINNER_BULLET = Glyph.bulletFilled;

export type AgentDisplayStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "interrupted";

export function agentStatusGlyph(status: AgentDisplayStatus): {
  glyph: string;
  color: InkColor | undefined;
} {
  if (status === "done") return { glyph: TICK, color: Color.success };
  if (status === "failed") return { glyph: CROSS, color: Color.error };
  if (status === "skipped") return { glyph: CROSS, color: Color.subtle };
  if (status === "running") return { glyph: BULLET_VIEWED, color: undefined };
  if (status === "queued") return { glyph: CIRCLE_DOTTED, color: Color.muted };
  return { glyph: CIRCLE_DOTTED, color: Color.subtle };
}

export const PANEL_STATUSES = ["idle", "done", "paused", "stopped", "failed"] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

// "stopped" mirrors the transcript's warning-colored "was stopped" notice so
// a user-initiated kill never reads as a failure across the two surfaces.
const PANEL_STATUS_COLOR: Record<PanelStatus, InkColor> = {
  idle: Color.muted,
  done: Color.success,
  paused: Color.warning,
  stopped: Color.warning,
  failed: Color.error,
};

export function panelStatusColor(status: PanelStatus): InkColor {
  return PANEL_STATUS_COLOR[status];
}

// A completed agent stays attached and steerable (idle); a completed
// workflow is terminal (done). The panel vocabulary is fixed to
// PANEL_STATUSES.
export function agentPanelStatus(status: string): PanelStatus | undefined {
  if (status === "completed") return "idle";
  if (status === "killed") return "stopped";
  if (status === "error") return "failed";
  return undefined;
}

export function workflowPanelStatus(status: string): PanelStatus | undefined {
  if (status === "completed") return "done";
  if (status === "paused") return "paused";
  if (status === "killed") return "stopped";
  if (status === "failed") return "failed";
  return undefined;
}
