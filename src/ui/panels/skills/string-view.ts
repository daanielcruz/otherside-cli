import { cycleSkillState, skillStateFor } from "@/engine/skills/overrides.ts";
import { list, type Skill } from "@/engine/skills/registry.ts";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";
import { hintChord, hintFor, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { searchKeyTransition } from "@/ui/chrome/panel-search.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  footerPanelBodyBudget,
  listOverflowLine,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";
import {
  filterSkills,
  renderSkillRowLine,
  skillLockAuthority,
  sortSkillsBySource,
  sortSkillsByTokens,
} from "@/ui/panels/skills/rows.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
/** Rows the window gives up to the two overflow markers. */
const OVERFLOW_MARKER_ROWS = 2;

/** `Esc to close` — one hint in the pair form the footer builder takes. */
function hintPair(hint: PanelHint): [string, string] {
  return [hintChord(hint.keys), hint.label];
}

const LIST_HINTS: [string, string][] = [
  hintFor("cycle"),
  hintFor("search"),
  hintFor("sort"),
  hintFor("close"),
].map(hintPair);
const SEARCH_HINTS: [string, string][] = [
  hintFor("typeToFilter"),
  hintFor("select"),
  hintFor("clear"),
].map(hintPair);
const NO_MATCH_HINTS: [string, string][] = [hintFor("search"), hintFor("close")].map(hintPair);
const EMPTY_HINTS: [string, string][] = [hintFor("close")].map(hintPair);

/**
 * Skills browser on the string model. One row per skill: its invocation state, name,
 * origin and what its frontmatter costs in context. Enter/space cycles the state of a
 * skill the user owns; a skill pinned by its own frontmatter or shipped by a plugin
 * shows a lock instead and is managed where its authority lives. `t` reorders by
 * context cost, `/` filters, Escape clears the filter and then closes.
 */
class SkillsPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private cursor = 0;
  private listOffset = 0;
  /** Skill rows the last frame showed at once; the page keys step by this. */
  private pageRows = 1;
  private query = "";
  private searchFocused = false;
  private searchCursor: number | undefined;
  private sortByTokens = false;

  constructor(private readonly close: () => void) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const all = this.orderedSkills();
    const visible = filterSkills(all, this.query);
    this.clampCursor(visible.length);

    if (all.length === 0) return renderFooterPanel(this.emptySpec(), width);

    const spec: FooterPanelSpec = {
      command: "/skills",
      title: "Skills",
      subtitle: this.countLabel(all.length, visible.length),
      footerHints: this.hints(visible.length),
      search: {
        query: this.query,
        placeholder: "Search skills…",
        focused: this.searchFocused,
        ...(this.searchCursor !== undefined ? { cursorOffset: this.searchCursor } : {}),
      },
      // The search box breathes above and the list starts flush beneath it, so the
      // rows read as one block hanging off the box rather than as a second island.
      searchMarginTop: 1,
      searchMarginBottom: 0,
      body: [],
    };
    if (this.sortByTokens) spec.subtitleSuffix = " · sorted by tokens";

    const note = this.pluginNote(all);
    const noteRows = note === undefined ? [] : ["", note];
    const rows =
      visible.length === 0
        ? ["", renderTextWithStyles(`No skills match "${this.query}"`, { color: Color.muted })]
        : this.listBody(visible, width, spec, noteRows.length);
    spec.body = [...rows, ...noteRows];

    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    const visible = filterSkills(this.orderedSkills(), this.query);
    if (!this.searchFocused && this.applyListShortcut(key, visible)) return;
    // The search machine runs first: typing seeds the filter here, so only the keys
    // it declines (chords, page and edge keys) reach the shared list vocabulary.
    if (this.applySearchTransition(key)) return;

    const action = listSelectKey(key, {
      cursor: this.cursor,
      count: visible.length,
      pageSize: this.pageRows,
    });
    if (action !== undefined) {
      this.cursor = action.cursor;
      if (action.activate) this.cycleSelected(visible);
      this.ctx?.requestRender();
      return;
    }

    if (panelKey(key) === "close") this.close();
  }

  /**
   * Keys the list owns outright. They run before the search machine so `t` and space
   * are not swallowed as filter seeds — the two characters this panel spends on
   * sorting and cycling never start a query.
   */
  private applyListShortcut(key: KeyEventData, visible: readonly Skill[]): boolean {
    if (key.ctrl || key.meta) return false;
    if (key.sequence === "t") {
      this.toggleSort();
      return true;
    }
    if (key.name === "return" || key.name === "space" || key.sequence === " ") {
      this.cycleSelected(visible);
      return true;
    }
    return false;
  }

  /** Skills in the active order — by origin, or by what they cost when `t` is on. */
  private orderedSkills(): Skill[] {
    const skills = list();
    return this.sortByTokens ? sortSkillsByTokens(skills) : sortSkillsBySource(skills);
  }

  private countLabel(total: number, visible: number): string {
    const noun = pluralize(total, "skill");
    return this.query.length === 0 ? `${total} ${noun}` : `${visible}/${total} ${noun}`;
  }

  private hints(visibleCount: number): [string, string][] {
    if (this.searchFocused) return SEARCH_HINTS;
    return visibleCount === 0 ? NO_MATCH_HINTS : LIST_HINTS;
  }

  /** A registry with nothing in it says where skills are read from. */
  private emptySpec(): FooterPanelSpec {
    return {
      command: "/skills",
      title: "Skills",
      footerHints: EMPTY_HINTS,
      body: [
        renderTextWithStyles("No skills found", { color: Color.muted }),
        renderTextWithStyles("Create skills in .otherside/skills/ or ~/.otherside/skills/", {
          color: Color.muted,
        }),
      ],
    };
  }

  /** Plugin skills answer to the plugins panel, so the list says so once at the bottom. */
  private pluginNote(skills: readonly Skill[]): string | undefined {
    if (!skills.some((skill) => skill.source === "plugin")) return undefined;
    return renderTextWithStyles("Plugin skills are managed via /plugins", { color: Color.muted });
  }

  /**
   * The rows that fit, plus a count of the ones that did not. The budget comes from
   * the chrome the spec describes, so the list shrinks with the terminal instead of
   * pushing the frame off screen.
   */
  private listBody(
    skills: readonly Skill[],
    width: number,
    spec: FooterPanelSpec,
    reservedRows: number,
  ): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const terminalRows = this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
    // The overflow markers and the plugin note share the body budget with the rows.
    const budget =
      footerPanelBodyBudget(spec, terminalRows, width) - OVERFLOW_MARKER_ROWS - reservedRows;
    const size = Math.max(1, budget);
    this.pageRows = size;
    const window = computeListWindow({
      cursor: this.cursor,
      total: skills.length,
      size,
      anchor: "edge",
      previousStart: this.listOffset,
    });
    this.listOffset = window.from;

    const body: string[] = [];
    if (window.above > 0) body.push(listOverflowLine("up", window.above, "above"));
    for (let index = window.from; index < window.to; index++) {
      const skill = skills[index]!;
      body.push(
        renderSkillRowLine({
          skill,
          state: skillStateFor(skill),
          selected: index === this.cursor,
          contentWidth,
        }),
      );
    }
    if (window.below > 0) body.push(listOverflowLine("down", window.below, "below"));
    return body;
  }

  /**
   * Route the key through the shared search machine. Typing seeds the box the way the
   * list expects: any printable character starts a filter without a leading `/`.
   */
  private applySearchTransition(key: KeyEventData): boolean {
    const transition = searchKeyTransition({
      state: {
        focused: this.searchFocused,
        query: this.query,
        ...(this.searchCursor !== undefined ? { cursorOffset: this.searchCursor } : {}),
      },
      key,
      policy: "slash-and-typing-seeds",
      atListTop: this.cursor === 0,
    });
    if (transition === undefined) return false;
    if (transition.state.query !== this.query) {
      this.cursor = 0;
      this.listOffset = 0;
    }
    this.query = transition.state.query;
    this.searchFocused = transition.state.focused;
    this.searchCursor = transition.state.cursorOffset;
    this.ctx?.requestRender();
    return true;
  }

  private toggleSort(): void {
    this.sortByTokens = !this.sortByTokens;
    this.cursor = 0;
    this.listOffset = 0;
    this.ctx?.requestRender();
  }

  private cycleSelected(skills: readonly Skill[]): void {
    const skill = skills[this.cursor];
    if (skill === undefined || skillLockAuthority(skill) !== undefined) return;
    cycleSkillState(skill);
    this.ctx?.requestRender();
  }

  private clampCursor(count: number): void {
    this.cursor = count === 0 ? 0 : Math.max(0, Math.min(count - 1, this.cursor));
  }
}

export function createSkillsPanel(close: () => void): StringViewPanel {
  return new SkillsPanel(close);
}
