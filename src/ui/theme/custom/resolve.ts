import { parseColorValue } from "@/ui/theme/custom/color-value.ts";
import type { ColorKey, ThemeRecord } from "@/ui/theme/theme.ts";

/**
 * The slots a palette carries, in the order the record declares them. Read from
 * a real record rather than a hand-kept list, so a new slot is editable the
 * moment it exists.
 */
export function themeSlotNames(base: ThemeRecord): ColorKey[] {
  return Object.keys(base) as ColorKey[];
}

export function isThemeSlot(base: ThemeRecord, name: string): name is ColorKey {
  return Object.hasOwn(base, name);
}

/**
 * Lays stored values over a palette. A slot the palette does not declare, or a
 * value the style model cannot render, is skipped: the base colour shows through
 * instead, which keeps a partly-damaged record usable.
 */
export function applyThemeOverrides(
  base: ThemeRecord,
  overrides: Readonly<Record<string, string>>,
): ThemeRecord {
  const resolved: ThemeRecord = { ...base };
  for (const [slot, written] of Object.entries(overrides)) {
    if (!isThemeSlot(base, slot)) continue;
    const color = parseColorValue(written);
    if (color === undefined) continue;
    resolved[slot] = color;
  }
  return resolved;
}

/** The stored values that name a real slot and parse, keyed by slot. */
export function usableOverrides(
  base: ThemeRecord,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const usable: Record<string, string> = {};
  for (const [slot, written] of Object.entries(overrides)) {
    if (isThemeSlot(base, slot) && parseColorValue(written) !== undefined) {
      usable[slot] = written;
    }
  }
  return usable;
}
