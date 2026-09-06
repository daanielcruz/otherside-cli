import type { Skill } from "@/engine/skills/registry.ts";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import {
  MENU_ROW_WIDTH,
  type PanelDetailView,
  SKILL_DETAILS_HINTS,
} from "@/ui/panels/plugins/chrome.ts";
import type { InstalledItem } from "@/ui/panels/plugins/installed-rows.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

type SkillRow = Extract<InstalledItem, { type: "skill" }>;

/** The states a skill can be put in, most permissive first. */
export const SKILL_STATE_ORDER = ["on", "name-only", "user-invocable-only", "off"] as const;

export function skillSourceLabel(source: Skill["source"]): string {
  if (source === "user") return "user";
  if (source === "project") return "project";
  return "built-in";
}

/** Roughly what the skill costs to keep in context, in tokens. */
export function skillTokenEstimate(skill: Skill): number {
  return Math.round(
    [skill.name, skill.description, skill.whenToUse].filter(Boolean).join(" ").length / 4,
  );
}

/**
 * One skill: what it does, what it costs, and which state it is in. The state list opens
 * on the current state, and a skill whose frontmatter fixes model invocability shows the
 * states it cannot leave as locked rather than hiding them.
 */
export function skillDetailView(input: {
  item: SkillRow;
  contentWidth: number;
  stateIndex: number;
}): PanelDetailView {
  const { item, contentWidth, stateIndex } = input;
  const states = [item.state, ...SKILL_STATE_ORDER.filter((state) => state !== item.state)];
  const body: string[] = [];
  body.push(renderTextWithStyles(item.name, { bold: true }));
  if (item.description) {
    for (const line of wrapProse(item.description, contentWidth)) {
      body.push(renderTextWithStyles(line, { color: Color.muted }));
    }
  }
  if (item.whenToUse) {
    body.push(renderTextWithStyles(`When to use: ${item.whenToUse}`, { color: Color.muted }));
  }
  body.push(
    renderTextWithStyles(`Source: ${item.sourceLabel} · ~${item.tokenEstimate} tokens`, {
      color: Color.muted,
    }),
  );
  body.push(
    renderTextWithStyles(
      `Usage: ${
        item.usage
          ? `${item.usage.count}× · last used ${item.usage.daysSinceUse === 0 ? "today" : `${item.usage.daysSinceUse}d ago`}`
          : "never invoked"
      }`,
      { color: Color.muted },
    ),
  );
  if (item.skillRoot) {
    body.push(renderTextWithStyles(`Path: ${item.skillRoot}`, { color: Color.muted }));
  }
  body.push("");
  body.push(
    renderTextWithStyles(
      item.authorLocked ? "State: (on/name-only locked by frontmatter modelInvocable)" : "State:",
      { color: item.authorLocked ? Color.muted : Color.text },
    ),
  );
  for (let index = 0; index < states.length; index++) {
    const state = states[index]!;
    const locked = item.authorLocked && state !== "user-invocable-only" && state !== "off";
    const marker = state === item.state ? Glyph.radioOn : Glyph.circleLarge;
    body.push(
      renderPanelRowLine(
        {
          label: `${marker} ${state}${locked ? " (locked)" : ""}`,
          selected: index === stateIndex,
          muted: locked,
        },
        contentWidth,
        MENU_ROW_WIDTH,
      ),
    );
  }
  return { body, footerHints: SKILL_DETAILS_HINTS };
}
