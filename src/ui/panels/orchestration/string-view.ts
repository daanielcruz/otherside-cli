import { existsSync } from "node:fs";
import { TIER_NAMES, type TierName } from "@/engine/model/tier/names.ts";
import {
  type RosterEntry,
  type RosterScope,
  readScopedOverlay,
  reloadRosterOverlay,
  scopedOrchestrationPath,
  writeScopedTier,
} from "@/engine/model/tier/roster-overlay.ts";
import { seedTierRoster } from "@/engine/model/tier/tiers.ts";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { type EditorLaunch, openPathInEditor } from "@/kernel/std/proc/editor-launch.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import { isProviderId } from "@/kernel/std/types/provider-ids.ts";
import { applyBrokerEvent } from "@/store/subscribers/broker.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  type FooterPanelSpec,
  labelColumnWidth,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { cycleOrchestrationMode } from "@/ui/panels/config/rows.ts";
import {
  ADD_ROW_DESCRIPTION,
  ADD_ROW_LABEL,
  DRAFT_GUIDE,
  DRAFT_INVALID,
  displayPath,
  EMPTY_TIER_NOTE,
  entryLabel,
  IDLE_NOTE_LINES,
  JSON_EXAMPLE,
  JSON_HELP_LINES,
  LINEUP_SENTENCE,
  launchFailureMessage,
  MODE_DESCRIPTION,
  MODE_VALUE,
  rootFooterHints,
  scopeDescription,
  TIER_LABEL,
  TIER_ROLE_SENTENCE,
  TIERS_HEADING,
  type TierRoster,
  tierColumnWidth,
  tierFooterHints,
  tierRowDescription,
  titleCase,
} from "@/ui/panels/orchestration/copy.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const SCOPE_ROW_LABEL = "Save edits to";
const JSON_ROW_LABEL = "Edit as JSON";

type View = { kind: "root" } | { kind: "tier"; tier: TierName } | { kind: "json-info" };

/**
 * Orchestration mode manager on the string model. Cycles Disabled/Default/Feudalism
 * (session broker + config persist on Enter), and when Feudalism is active edits the
 * per-scope tier lineups (reorder/remove/add/reset) or opens the roster JSON file.
 * Escape backs out of tier/JSON views or closes the overlay.
 */
class OrchestrationPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private mode: OrchestrationMode;
  private scope: RosterScope = "user";
  private view: View = { kind: "root" };
  private selected = 0;
  private draft: string | null = null;
  private draftInvalid = false;
  private launch: EditorLaunch | null = null;
  private revision = 0;
  private readonly cwd = process.cwd();

  constructor(private readonly close: () => void) {
    const broker = readStringViewBrokerState();
    const cfg = loadConfigSync();
    this.mode = broker.orchestrationMode ?? cfg.orchestrationMode ?? "disabled";
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    if (this.view.kind === "json-info") return this.renderJsonInfo(width);
    if (this.view.kind === "tier") return this.renderTier(this.view.tier, width, contentWidth);
    return this.renderRoot(width, contentWidth);
  }

  handleKey(key: KeyEventData): void {
    if (this.draft !== null && this.view.kind === "tier") {
      this.handleDraftKey(key, this.view.tier);
      return;
    }

    // `handleBack` owns what a level means here: it pops one when there is one and
    // closes the panel when there is not.
    if (panelKey(key) === "close") {
      this.handleBack();
      return;
    }

    if (key.name === "up") {
      this.moveSelected(-1);
      return;
    }
    if (key.name === "down") {
      this.moveSelected(1);
      return;
    }
    if (panelKey(key) === "confirm") {
      this.activate();
      return;
    }

    const sequence = key.sequence;
    if (key.ctrl || key.meta || sequence === undefined) return;

    if (this.view.kind === "tier") {
      this.handleTierHotkey(sequence, this.view.tier);
      return;
    }
    if (this.view.kind === "root" && this.mode === "feudalism" && sequence === "s") {
      this.toggleScope();
    }
  }

  // A text draft: Enter and Escape accept and abandon what is being typed, which
  // is the draft's meaning rather than the panel's, so they stay named here.
  private handleDraftKey(key: KeyEventData, tier: TierName): void {
    if (key.name === "return") {
      this.commitDraft(tier);
      return;
    }
    if (key.name === "escape") {
      this.draft = null;
      this.draftInvalid = false;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      this.draft = (this.draft ?? "").slice(0, -1);
      this.draftInvalid = false;
      this.ctx?.requestRender();
      return;
    }
    const sequence = key.sequence;
    if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
      this.draft = (this.draft ?? "") + sequence;
      this.draftInvalid = false;
      this.ctx?.requestRender();
    }
  }

  private handleTierHotkey(sequence: string, tier: TierName): void {
    const roster = this.rosters()[tier];
    const entries = [...roster.entries];
    const sel = this.clampedSelected();
    const onEntry = sel < entries.length;

    if (sequence === "x" && onEntry) {
      entries.splice(sel, 1);
      this.writeTier(tier, entries);
      return;
    }
    if ((sequence === "+" || sequence === "=") && onEntry && sel > 0) {
      const moved = entries.splice(sel, 1)[0] as RosterEntry;
      entries.splice(sel - 1, 0, moved);
      this.writeTier(tier, entries);
      this.selected = sel - 1;
      this.ctx?.requestRender();
      return;
    }
    if (sequence === "-" && onEntry && sel < entries.length - 1) {
      const moved = entries.splice(sel, 1)[0] as RosterEntry;
      entries.splice(sel + 1, 0, moved);
      this.writeTier(tier, entries);
      this.selected = sel + 1;
      this.ctx?.requestRender();
      return;
    }
    if (sequence === "r" && roster.overridden) {
      this.writeTier(tier, null);
      this.selected = 0;
      this.ctx?.requestRender();
    }
  }

  private handleBack(): void {
    if (this.draft !== null) {
      this.draft = null;
      this.draftInvalid = false;
      this.ctx?.requestRender();
      return;
    }
    if (this.view.kind !== "root") {
      this.view = { kind: "root" };
      this.selected = 0;
      this.launch = null;
      this.ctx?.requestRender();
      return;
    }
    this.close();
  }

  private moveSelected(delta: number): void {
    const count = this.rowCount();
    if (count <= 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.clampedSelected() + delta));
    this.ctx?.requestRender();
  }

  private activate(): void {
    if (this.view.kind === "tier") {
      const tier = this.view.tier;
      if (this.clampedSelected() === this.rosters()[tier].entries.length) this.draft = "";
      this.ctx?.requestRender();
      return;
    }
    if (this.view.kind === "json-info") return;

    const sel = this.clampedSelected();
    if (sel === 0) {
      this.persistMode(cycleOrchestrationMode(this.mode, 1));
      return;
    }
    if (this.mode !== "feudalism") return;
    if (sel === 1) {
      this.toggleScope();
      return;
    }
    const tier = TIER_NAMES[sel - 2];
    if (tier !== undefined) {
      this.view = { kind: "tier", tier };
      this.selected = 0;
      this.ctx?.requestRender();
      return;
    }
    this.enterJsonEdit();
  }

  private persistMode(next: OrchestrationMode): void {
    this.mode = next;
    applyBrokerEvent({ kind: "set_orchestration_mode", mode: next }, { orchestrationMode: next });
    void updateConfig((current) => {
      current.orchestrationMode = next;
    });
    // Non-feudal modes only have the mode row; keep the cursor valid.
    this.selected = Math.min(this.selected, this.rowCount() - 1);
    this.ctx?.requestRender();
  }

  private toggleScope(): void {
    this.scope = this.scope === "user" ? "project" : "user";
    this.revision += 1;
    this.ctx?.requestRender();
  }

  private enterJsonEdit(): void {
    const path = scopedOrchestrationPath(this.scope, this.cwd);
    const result = openPathInEditor(path);
    this.launch = result;
    if (!result.ok) {
      this.view = { kind: "json-info" };
      this.ctx?.requestRender();
    }
  }

  private commitDraft(tier: TierName): void {
    const text = (this.draft ?? "").trim();
    const [provider, ...rest] = text.split(/[\s/]+/);
    const model = rest.join("/");
    if (!isProviderId(provider) || model.trim().length === 0) {
      this.draftInvalid = true;
      this.ctx?.requestRender();
      return;
    }
    this.draft = null;
    this.draftInvalid = false;
    this.writeTier(tier, [...this.rosters()[tier].entries, { provider, model }]);
  }

  private writeTier(tier: TierName, entries: RosterEntry[] | null): void {
    writeScopedTier(this.scope, this.cwd, tier, entries);
    reloadRosterOverlay(this.cwd);
    this.revision += 1;
    this.ctx?.requestRender();
  }

  private rosters(): Record<TierName, TierRoster> {
    void this.revision;
    const byTier = {} as Record<TierName, TierRoster>;
    const scoped = readScopedOverlay(this.scope, this.cwd);
    for (const tier of TIER_NAMES) {
      const override = scoped[tier];
      byTier[tier] =
        override !== undefined
          ? { entries: override, overridden: true }
          : {
              entries: seedTierRoster(tier).map((m) => ({ provider: m.provider, model: m.name })),
              overridden: false,
            };
    }
    return byTier;
  }

  private rowCount(): number {
    if (this.view.kind === "tier") return this.rosters()[this.view.tier].entries.length + 1;
    return this.mode === "feudalism" ? 2 + TIER_NAMES.length + 1 : 1;
  }

  private clampedSelected(): number {
    return Math.min(this.selected, Math.max(0, this.rowCount() - 1));
  }

  private renderRoot(width: number, contentWidth: number): string[] {
    const sel = this.clampedSelected();
    // Sized to the labels this mode actually shows, so the values sit beside them.
    const column = labelColumnWidth(
      this.mode === "feudalism"
        ? ["Mode", SCOPE_ROW_LABEL, ...TIER_NAMES.map((tier) => TIER_LABEL[tier]), JSON_ROW_LABEL]
        : ["Mode"],
    );
    const body: string[] = [];
    body.push(
      renderPanelRowLine(
        {
          label: "Mode",
          value: MODE_VALUE[this.mode],
          description: MODE_DESCRIPTION[this.mode],
          selected: sel === 0,
        },
        contentWidth,
        column,
      ),
    );

    if (this.mode !== "feudalism") {
      body.push("");
      for (const line of IDLE_NOTE_LINES) {
        body.push(renderTextWithStyles(line, { color: Color.muted }));
      }
    } else {
      const projectFileExists = existsSync(scopedOrchestrationPath("project", this.cwd));
      const rosters = this.rosters();
      body.push(
        renderPanelRowLine(
          {
            label: SCOPE_ROW_LABEL,
            value: this.scope === "project" ? "This project" : "All projects",
            description: scopeDescription(this.scope, projectFileExists),
            selected: sel === 1,
          },
          contentWidth,
          column,
        ),
      );
      body.push("");
      body.push(renderTextWithStyles(TIERS_HEADING, { color: Color.muted }));
      TIER_NAMES.forEach((tier, i) => {
        const roster = rosters[tier];
        const empty = roster.entries.length === 0;
        body.push(
          renderPanelRowLine(
            {
              label: TIER_LABEL[tier],
              value: roster.entries[0]?.model ?? "Off",
              description: tierRowDescription(roster),
              selected: sel === 2 + i,
              ...(empty ? { valueColor: Color.muted } : {}),
            },
            contentWidth,
            column,
          ),
        );
      });
      body.push("");
      body.push(
        renderPanelRowLine(
          {
            label: JSON_ROW_LABEL,
            description: "opens the file in your editor",
            selected: sel === 2 + TIER_NAMES.length,
          },
          contentWidth,
          column,
        ),
      );
    }

    const spec: FooterPanelSpec = {
      command: "/orchestration",
      title: "Orchestration",
      subtitle: "Choose how agents pick their models.",
      footerHints: rootFooterHints(this.mode),
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private renderTier(tier: TierName, width: number, contentWidth: number): string[] {
    const roster = this.rosters()[tier];
    const column = tierColumnWidth(roster.entries.length);
    const sel = this.clampedSelected();
    const onAddRow = sel === roster.entries.length;
    const drafting = this.draft !== null;
    const body: string[] = [];

    roster.entries.forEach((entry, index) => {
      body.push(
        renderPanelRowLine(
          {
            label: entryLabel(index),
            value: entry.model,
            description: entry.provider,
            selected: sel === index,
          },
          contentWidth,
          column,
        ),
      );
    });

    if (roster.entries.length === 0) {
      body.push(renderTextWithStyles(EMPTY_TIER_NOTE, { color: Color.muted }));
    }

    if (drafting) {
      body.push(draftRowLine(this.draft ?? "", column));
    } else {
      body.push(
        renderPanelRowLine(
          {
            label: ADD_ROW_LABEL,
            description: ADD_ROW_DESCRIPTION,
            selected: onAddRow,
            muted: !onAddRow,
          },
          contentWidth,
          column,
        ),
      );
    }

    if (this.draftInvalid) {
      body.push("");
      body.push(renderTextWithStyles(DRAFT_INVALID, { color: Color.warning }));
    }

    const scopePath = scopedOrchestrationPath(this.scope, this.cwd);
    const subtitle = `${TIER_ROLE_SENTENCE[tier]} ${LINEUP_SENTENCE}`;
    const bodyWithPath = [
      ...body,
      "",
      renderTextWithStyles(`Edits write ${displayPath(scopePath)}`, { color: Color.muted }),
    ];

    const spec: FooterPanelSpec = {
      command: "/orchestration",
      title: `Orchestration — ${titleCase(tier)}`,
      subtitle,
      footerHints: tierFooterHints(drafting, onAddRow, roster.overridden),
      body: bodyWithPath,
    };
    if (drafting) spec.inputGuide = DRAFT_GUIDE;
    return renderFooterPanel(spec, width);
  }

  private renderJsonInfo(width: number): string[] {
    const scopePath = scopedOrchestrationPath(this.scope, this.cwd);
    const body: string[] = [];
    const failure = launchFailureMessage(this.launch);
    if (failure.length > 0) {
      body.push(renderTextWithStyles(failure, { color: Color.text }));
      body.push("");
    }
    body.push(renderTextWithStyles("You can edit the file by hand:", { color: Color.text }));
    body.push(renderTextWithStyles(displayPath(scopePath), { color: Color.primary }));
    body.push("");
    body.push(renderTextWithStyles("Example:", { color: Color.text }));
    for (const line of JSON_EXAMPLE.split("\n")) {
      body.push(renderTextWithStyles(line, { color: Color.muted }));
    }
    body.push("");
    for (const line of JSON_HELP_LINES) {
      body.push(renderTextWithStyles(line, { color: Color.muted }));
    }

    const spec: FooterPanelSpec = {
      command: "/orchestration",
      title: "Orchestration — Edit as JSON",
      footerHints: [["Esc", "back"]],
      body,
    };
    return renderFooterPanel(spec, width);
  }
}

function draftRowLine(draft: string, column: number): string {
  const marker = renderTextWithStyles(Glyph.chevron, { color: Color.panelAccent });
  const label = renderTextWithStyles(ADD_ROW_LABEL, { color: Color.panelAccent, bold: true });
  const pad = Math.max(1, column - ADD_ROW_LABEL.length);
  const cursor =
    renderTextWithStyles(draft, { color: Color.text }) +
    renderTextWithStyles(" ", { inverse: true });
  return marker + label + " ".repeat(pad) + cursor;
}

export function createOrchestrationPanel(close: () => void, _props?: unknown): StringViewPanel {
  return new OrchestrationPanel(close);
}
