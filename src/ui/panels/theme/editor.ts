import type { ThemeName } from "@/kernel/config/theme-names.ts";
import {
  type CustomThemeSource,
  type StoredTheme,
  themeSlug,
  writeStoredTheme,
} from "@/kernel/theme/store.ts";
import { parseColorValue } from "@/ui/theme/custom/color-value.ts";
import { themeSlotNames } from "@/ui/theme/custom/resolve.ts";
import { getThemeRecord, type ThemeRecord } from "@/ui/theme/theme.ts";

export type EditorScreen = "name" | "slots" | "value";

/** Slug used while the name is still empty, so the save path is always shown. */
export const UNNAMED_SLUG = "theme";

export interface SlotRow {
  slot: string;
  /** What the slot paints as now, override included. */
  current: string;
  /** What the base palette gives it, shown alongside once overridden. */
  preset: string;
  overridden: boolean;
}

/**
 * The custom-theme editor's state, independent of how it is drawn. Every screen
 * writes through to the same record, so a value saved on one screen is visible
 * to the next without a reload.
 */
export class ThemeEditor {
  screen: EditorScreen;
  name: string;
  filter = "";
  cursor = 0;
  draft = "";

  private readonly base: ThemeName;
  private readonly baseRecord: ThemeRecord;
  private readonly source: CustomThemeSource;
  private readonly fixedSlug: string | undefined;
  private overrides: Record<string, string>;

  /**
   * Opens on an existing record, or on a blank one when `stored` is absent. An
   * existing record is opened with its stored values already in hand: the editor
   * writes the whole override set on every save, so starting empty would drop
   * every slot the user had already set.
   */
  constructor(stored?: StoredTheme, base: ThemeName = "dark") {
    this.screen = stored ? "slots" : "name";
    this.name = stored?.name ?? "";
    this.base = stored?.base ?? base;
    this.baseRecord = getThemeRecord(this.base);
    this.source = stored?.source ?? "user";
    this.fixedSlug = stored?.slug;
    this.overrides = { ...(stored?.overrides ?? {}) };
  }

  get baseName(): ThemeName {
    return this.base;
  }

  get slug(): string {
    return this.fixedSlug ?? themeSlug(this.name);
  }

  /** The stem a save would use; never empty, so the path line always resolves. */
  get displaySlug(): string {
    const slug = this.slug;
    return slug.length === 0 ? UNNAMED_SLUG : slug;
  }

  get overrideCount(): number {
    return Object.keys(this.overrides).length;
  }

  get canContinue(): boolean {
    return themeSlug(this.name).length > 0;
  }

  /** True while the value in the prompt cannot be stored. */
  get draftRejected(): boolean {
    return parseColorValue(this.draft) === undefined;
  }

  rows(): SlotRow[] {
    const needle = this.filter.trim().toLowerCase();
    const rows: SlotRow[] = [];
    for (const slot of themeSlotNames(this.baseRecord)) {
      if (needle.length > 0 && !slot.toLowerCase().includes(needle)) continue;
      const preset = this.baseRecord[slot] ?? "";
      const written = this.overrides[slot];
      rows.push({
        slot,
        current: written ?? preset,
        preset,
        overridden: written !== undefined,
      });
    }
    return rows;
  }

  selected(): SlotRow | undefined {
    return this.rows()[this.cursor];
  }

  moveCursor(next: number): void {
    const count = this.rows().length;
    this.cursor = count === 0 ? 0 : Math.max(0, Math.min(count - 1, next));
  }

  setFilter(value: string): void {
    this.filter = value;
    this.cursor = 0;
  }

  /** Moves to the slot list, keeping the name that was typed. */
  continueToSlots(): boolean {
    if (!this.canContinue) return false;
    this.screen = "slots";
    this.cursor = 0;
    return true;
  }

  openValue(): boolean {
    const row = this.selected();
    if (!row) return false;
    this.draft = row.current;
    this.screen = "value";
    return true;
  }

  /** Stores the prompt's value when it parses, and returns to the slot list. */
  commitValue(): boolean {
    const row = this.selected();
    if (!row || this.draftRejected) return false;
    this.overrides[row.slot] = this.draft.trim();
    this.screen = "slots";
    this.persist();
    return true;
  }

  cancelValue(): void {
    this.screen = "slots";
    this.draft = "";
  }

  /** Drops the selected slot's override so the base palette shows through. */
  resetSelected(): boolean {
    const row = this.selected();
    if (!row?.overridden) return false;
    delete this.overrides[row.slot];
    this.persist();
    return true;
  }

  toStored(): StoredTheme {
    return {
      slug: this.displaySlug,
      name: this.name.trim(),
      base: this.base,
      overrides: { ...this.overrides },
      source: this.source,
    };
  }

  /**
   * Writes the record. Every slot edit persists immediately, so leaving the
   * editor by any route keeps what was already set.
   */
  persist(): void {
    if (!this.canContinue) return;
    writeStoredTheme(this.toStored());
  }
}
