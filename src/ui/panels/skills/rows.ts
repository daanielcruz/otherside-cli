import type { Skill } from "@/engine/skills/registry.ts";
import type { SkillState } from "@/kernel/config/config.ts";
import { formatTokens } from "@/kernel/std/text/format.ts";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/**
 * View model for the skills browser: how a skill's state, origin and context cost
 * read as one flowing row. Kept apart from the panel so the row grammar can be
 * asserted without mounting a terminal.
 */

/** Columns the state label occupies, so every name starts on the same column. */
const STATE_LABEL_WIDTH = 9;
/** Gap between the state column and the skill name. */
const STATE_GAP = "  ";
/** Below this an estimate is noise, so it reads as a floor instead of a number. */
const TOKEN_ESTIMATE_FLOOR = 20;
/** Estimates round to this step — the tenth digit is the only honest one. */
const TOKEN_ESTIMATE_STEP = 10;
/** Bytes of frontmatter per token, the ratio the loader assumes for English prose. */
const BYTES_PER_TOKEN = 4;
/** Marker for a row whose state this panel may not change. */
const LOCK_GLYPH = "🔒";

/** Who owns a skill's state when the user does not. */
export type SkillLockAuthority = "author" | "plugin";

interface SkillStateDisplay {
  glyph: string;
  label: string;
  color: TerminalColor;
}

/** State → (glyph + label + color). The same triple the installed list draws. */
const SKILL_STATE_DISPLAY: Record<SkillState, SkillStateDisplay> = {
  on: { glyph: Glyph.check, label: "on", color: Color.success },
  "name-only": { glyph: Glyph.bulletFilled, label: "name-only", color: Color.text },
  "user-invocable-only": { glyph: Glyph.circleLarge, label: "user-only", color: Color.warning },
  off: { glyph: Glyph.cross, label: "off", color: Color.error },
};

/**
 * The authority that pins a skill's state, if any. A skill whose frontmatter opts
 * out of model invocation is the author's call; a skill shipped by a plugin is
 * managed on the plugins panel. Everything else is the user's to cycle.
 */
export function skillLockAuthority(skill: Skill): SkillLockAuthority | undefined {
  if (skill.authorModelLock) return "author";
  if (skill.source === "plugin") return "plugin";
  return undefined;
}

/** Human-facing origin: bundled skills collapse to "built-in", the rest say where they live. */
export function skillSourceLabel(source: Skill["source"]): string {
  return source === "builtin" ? "built-in" : source;
}

/** Roughly what the skill's frontmatter costs to keep in the model's context. */
export function skillTokenEstimate(skill: Skill): number {
  const frontmatter = [skill.name, skill.description, skill.whenToUse].filter(Boolean).join(" ");
  return Math.round(frontmatter.length / BYTES_PER_TOKEN);
}

/**
 * The estimate as a label. Under the floor the exact number says nothing useful, so
 * the row reads as a bound; above it the value rounds to the nearest ten.
 */
export function formatTokenEstimate(tokens: number): string {
  if (tokens < TOKEN_ESTIMATE_FLOOR) return `< ${TOKEN_ESTIMATE_FLOOR}`;
  return `~${formatTokens(Math.round(tokens / TOKEN_ESTIMATE_STEP) * TOKEN_ESTIMATE_STEP)}`;
}

/** Default order: origin first, then name — skills of one origin read as a block. */
export function sortSkillsBySource(skills: readonly Skill[]): Skill[] {
  return [...skills].sort(
    (left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name),
  );
}

/** Cost order: the heaviest frontmatter first, so trimming context starts at the top. */
export function sortSkillsByTokens(skills: readonly Skill[]): Skill[] {
  return [...skills].sort(
    (left, right) =>
      skillTokenEstimate(right) - skillTokenEstimate(left) || left.name.localeCompare(right.name),
  );
}

/** Skills whose name, description or origin contains the query (case-insensitive). */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  if (query.length === 0) return [...skills];
  const needle = query.toLowerCase();
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle) ||
      skillSourceLabel(skill.source).toLowerCase().includes(needle),
  );
}

/**
 * One skill, drawn: state column, name, then the muted trail that says where it came
 * from, what it costs, and who holds its state. A locked row trades the state glyph
 * for a lock so the column still aligns.
 */
export function renderSkillRowLine(input: {
  skill: Skill;
  state: SkillState;
  selected: boolean;
  contentWidth: number;
}): string {
  const { skill, state, selected, contentWidth } = input;
  const lock = skillLockAuthority(skill);
  const display = SKILL_STATE_DISPLAY[state];

  const marker = selected
    ? renderTextWithStyles(Glyph.chevron, { color: Color.panelAccent })
    : " ".repeat(Glyph.chevron.length);
  const stateColumn =
    lock === undefined
      ? renderTextWithStyles(`${display.glyph} ${display.label.padEnd(STATE_LABEL_WIDTH)}`, {
          color: display.color,
        })
      : renderTextWithStyles(`${LOCK_GLYPH} ${display.label.padEnd(STATE_LABEL_WIDTH)}`, {
          color: Color.muted,
        });
  const name = renderTextWithStyles(skill.name, {
    color: selected ? Color.panelAccent : Color.text,
  });
  const trail = renderTextWithStyles(
    ` · ${skillSourceLabel(skill.source)} · ${formatTokenEstimate(skillTokenEstimate(skill))} tok${
      lock === undefined ? "" : ` · locked by ${lock}`
    }`,
    { color: Color.muted },
  );

  return cellClip(marker + stateColumn + STATE_GAP + name + trail, contentWidth);
}
