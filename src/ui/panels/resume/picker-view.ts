import { hintFor, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import {
  type PanelPickerRowSpec,
  renderPanelPickerRowLines,
} from "@/ui/chrome/string-view-panel.ts";
import type { SessionEntry } from "@/ui/panels/resume/entries.ts";

export const SEARCH_HINTS: readonly PanelHint[] = [
  hintFor("typeToSearch"),
  hintFor("enterSelect"),
  hintFor("clear"),
];
export const RENAME_HINTS: readonly PanelHint[] = [hintFor("enterSave"), hintFor("cancel")];

export function renderResumeRowLines(spec: PanelPickerRowSpec, width: number): string[] {
  return renderPanelPickerRowLines(spec, Math.max(1, width - 4));
}

export function listHints(
  branch: string | null,
  branchFilterEnabled: boolean,
  showAllProjects: boolean,
  hasSelection: boolean,
): PanelHint[] {
  const hints: PanelHint[] = [
    {
      keys: ["Ctrl+A"],
      label: showAllProjects ? "to only show current repo" : "to show all projects",
    },
  ];
  if (branch !== null) {
    hints.push({
      keys: ["Ctrl+B"],
      label: branchFilterEnabled ? "to show all branches" : "to only show current branch",
    });
  }
  if (hasSelection) {
    hints.push(hintFor("spacePreview"), hintFor("rename"));
  }
  hints.push(hintFor("typeToSearch"), hintFor("cancel"));
  return hints;
}

export function currentBranchFrom(entries: readonly SessionEntry[]): string | null {
  for (const entry of entries) {
    if (entry.phase === "enriched" && entry.branch !== null) return entry.branch;
  }
  return entries.length > 0 ? "HEAD" : null;
}

export function basenameOfCwd(cwd: string): string | null {
  const trimmed = cwd.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return null;
  const name = trimmed.slice(idx + 1);
  return name.length > 0 ? name : null;
}

export function foldText(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
