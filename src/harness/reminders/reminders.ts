import { stringWidth } from "@/terminal-runtime";

const SKILL_LISTING_CHAR_BUDGET = 8_000;
const SKILL_LISTING_MAX_DESC_CHARS = 1_536;
const ELLIPSIS = "…";

export interface SkillListingEntry {
  name: string;
  description: string;
  whenToUse?: string;
  builtin: boolean;
}

function skillDescription(skill: SkillListingEntry): string {
  const raw = skill.description.length > 0 ? skill.description : (skill.whenToUse ?? "");
  if (raw.length <= SKILL_LISTING_MAX_DESC_CHARS) return raw;
  return raw.slice(0, SKILL_LISTING_MAX_DESC_CHARS - 1) + ELLIPSIS;
}

interface SkillEntry {
  protected: boolean;
  nameLine: string;
  fullLine: string;
  upgradeCost: number;
}

function toEntry(skill: SkillListingEntry): SkillEntry {
  const nameLine = `- ${skill.name}`;
  const fullLine = `- ${skill.name}: ${skillDescription(skill)}`;
  return {
    protected: skill.builtin,
    nameLine,
    fullLine,
    upgradeCost: stringWidth(fullLine) - stringWidth(nameLine),
  };
}

function joinedWidth(lines: string[]): number {
  if (lines.length === 0) return 0;
  return stringWidth(lines.join("\n"));
}

function chosenLines(entries: SkillEntry[], upgraded: Set<SkillEntry>): string[] {
  return entries.map((e) => (e.protected || upgraded.has(e) ? e.fullLine : e.nameLine));
}

function upgradeWithinSlack(entries: SkillEntry[], slack: number): Set<SkillEntry> {
  const upgraded = new Set<SkillEntry>();
  let remaining = slack;
  for (const entry of entries) {
    if (entry.protected || entry.upgradeCost > remaining) continue;
    upgraded.add(entry);
    remaining -= entry.upgradeCost;
  }
  return upgraded;
}

function fitWithinBudget(skills: readonly SkillListingEntry[], budget: number): string[] {
  const entries = skills.map(toEntry);
  const fullLines = entries.map((e) => e.fullLine);
  if (joinedWidth(fullLines) <= budget) return fullLines;

  const baseline = entries.map((e) => (e.protected ? e.fullLine : e.nameLine));
  const upgraded = upgradeWithinSlack(entries, budget - joinedWidth(baseline));
  return chosenLines(entries, upgraded);
}

export function renderSkillsReminder(skills: readonly SkillListingEntry[]): string {
  if (skills.length === 0) return "";
  const lines = fitWithinBudget(skills, SKILL_LISTING_CHAR_BUDGET);
  return `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${lines.join("\n")}\n</system-reminder>\n`;
}

// Reminder renders own the `<system-reminder>` envelope; this is the one
// inverse for consumers that re-wrap or deliver the content bare.
export function renderUserContextInner(
  vars: { currentDate?: string; memory?: string } = {},
): string {
  const memory = vars.memory ?? "";
  const memorySection = memory.length === 0 ? "" : `${memory}\n`;
  const currentDate = vars.currentDate ?? "";
  const currentDateSection =
    currentDate.length === 0 ? "" : `# currentDate\nToday's date is ${currentDate}.\n`;
  return `${memorySection}${currentDateSection}`;
}

export function renderDeferredToolsReminder(
  baseNames: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
  extraNames: string[] = [],
): string {
  const names = [
    ...baseNames.filter((name) => !exclude.has(name)),
    ...extraNames.filter((name) => !exclude.has(name)).sort((a, b) => a.localeCompare(b)),
  ];
  return `<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n${names.join("\n")}\n</system-reminder>`;
}
