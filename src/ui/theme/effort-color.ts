import type { Color as InkColor } from "@/ink";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import { Color } from "@/ui/theme/theme.ts";

export type EffortColorLabel = EffortLevel | "ultracode" | "default" | "off";

export function effortColor(label: string): InkColor {
  const normalized = label.trim().toLowerCase();
  if (normalized.startsWith("ultracode")) return Color.accentWarm;
  switch (normalized) {
    case "xhigh":
      return Color.primaryGlow;
    case "max":
      return Color.error;
    case "high":
      return Color.primary;
    case "medium":
      return Color.success;
    case "low":
      return Color.text;
    case "default":
      return Color.text;
    case "off":
      return Color.muted;
    default:
      return Color.text;
  }
}
