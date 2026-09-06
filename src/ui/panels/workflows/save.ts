import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugifyWorkflowName } from "@/engine/background/workflows/runtime/history/paths.ts";
import { isErrno } from "@/kernel/std/errno.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type FooterPanelSpec,
  type ListPanelSpec,
  renderFooterPanel,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { WorkflowListItem } from "@/ui/panels/workflows/items.ts";
import { Color } from "@/ui/theme/theme.ts";

const WORKFLOW_DIR_SEGMENTS = [".otherside", "workflows"];
const PANEL_COMMAND = "/workflows";

/** Where a saved script lands: alongside the project, or in the user's own library. */
export type SaveScope = 0 | 1;

export type SaveOutcome =
  | { kind: "saved"; path: string }
  | { kind: "exists"; path: string }
  | { kind: "failed" };

export function workflowSaveDir(scope: SaveScope, projectRoot: string): string {
  return join(scope === 0 ? projectRoot : homedir(), ...WORKFLOW_DIR_SEGMENTS);
}

/**
 * The name the save dialog starts from. The user may replace it, and the slug is
 * derived from whatever they land on — so a collision is answered by renaming
 * rather than by overwriting someone else's script.
 */
export function defaultSaveName(item: WorkflowListItem): string {
  return item.name;
}

export function workflowSavePath(name: string, scope: SaveScope, projectRoot: string): string {
  return join(workflowSaveDir(scope, projectRoot), `${slugifyWorkflowName(name)}.js`);
}

/**
 * Write the script without ever replacing one already there: an existing file is
 * reported back so the user picks another scope or clears it themselves, because a
 * saved workflow is theirs and overwriting it silently would lose their edits.
 */
export async function saveWorkflowScript(
  item: WorkflowListItem,
  name: string,
  scope: SaveScope,
  projectRoot: string,
): Promise<SaveOutcome> {
  const path = workflowSavePath(name, scope, projectRoot);
  try {
    // A saved script is executable orchestration the user owns: the library and the
    // scripts in it stay readable by that user alone.
    await mkdir(workflowSaveDir(scope, projectRoot), { recursive: true, mode: 0o700 });
    await writeFile(path, item.script, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { kind: "saved", path };
  } catch (error: unknown) {
    return isErrno(error, "EEXIST") ? { kind: "exists", path } : { kind: "failed" };
  }
}

/** Which row of the save form the keys are addressing. */
export type SaveField = "name" | "scope";

/** Everything the save form remembers between keypresses. */
export interface SaveFormState {
  name: string;
  field: SaveField;
  scope: SaveScope;
}

export function openSaveForm(item: WorkflowListItem | undefined): SaveFormState {
  return { name: item ? defaultSaveName(item) : "", field: "name", scope: 0 };
}

/**
 * The form's response to a key, or null when the key is not the form's to take —
 * the caller then lets Enter and Escape act. The form reads top to bottom: the
 * name row hands down to the scopes, and among them the keys pick between the two.
 */
export function saveFormKey(state: SaveFormState, key: SaveFormKey): SaveFormState | null {
  if (key.name === "down") {
    if (state.field === "name") return { ...state, field: "scope" };
    return { ...state, scope: state.scope === 0 ? 1 : 0 };
  }
  if (key.name === "up") {
    if (state.field !== "scope") return state;
    return state.scope === 0 ? { ...state, field: "name" } : { ...state, scope: 0 };
  }
  if (state.field !== "name") return null;
  if (key.name === "backspace") return { ...state, name: state.name.slice(0, -1) };
  const typed = key.sequence;
  if (typed === undefined || key.ctrl === true || key.meta === true) return null;
  if (typed.length !== 1 || typed < " ") return null;
  return { ...state, name: state.name + typed };
}

/** The slice of a key event the save form reads. */
export interface SaveFormKey {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
}

export function renderSaveScopePicker(input: {
  item: WorkflowListItem | undefined;
  name: string;
  field: SaveField;
  scope: SaveScope;
  projectRoot: string;
  terminalRows: number;
  width: number;
}): string[] {
  const slug = slugifyWorkflowName(input.name);
  const nameRow = input.field === "name" ? `${input.name}▏` : input.name;
  const spec: ListPanelSpec = {
    command: PANEL_COMMAND,
    title: "Save workflow",
    items: [
      { id: "name", label: `Name  ${nameRow}`, value: slug.length > 0 ? `${slug}.js` : "" },
      { id: "project", label: `Project (${workflowSaveDir(0, input.projectRoot)})` },
      { id: "user", label: `User (${workflowSaveDir(1, input.projectRoot)})` },
    ],
    cursor: input.field === "name" ? 0 : input.scope + 1,
    maxRows: input.terminalRows,
    footerHints:
      input.field === "name"
        ? [
            ["Type", "to rename"],
            ["↓", "to scope"],
            ["Enter", "save"],
            ["Esc", "back"],
          ]
        : [
            ["↑/↓", "select scope"],
            ["Enter", "save"],
            ["Esc", "back"],
          ],
  };
  return renderListPanel(spec, input.width);
}

export function renderSaved(path: string, terminalRows: number, width: number): string[] {
  const spec: FooterPanelSpec = {
    command: PANEL_COMMAND,
    title: "Dynamic workflows",
    maxRows: terminalRows,
    footerHints: [["any key", "continue"]],
    body: [renderTextWithStyles(`Saved workflow to ${path}`, { color: Color.success })],
  };
  return renderFooterPanel(spec, width);
}

export function renderSaveError(path: string, terminalRows: number, width: number): string[] {
  const spec: FooterPanelSpec = {
    command: PANEL_COMMAND,
    title: "Save workflow",
    maxRows: terminalRows,
    footerHints: [["any key", "back"]],
    body: [
      renderTextWithStyles(`A workflow already exists at ${path}.`, { color: Color.error }),
      renderTextWithStyles("Pick a different scope, or rename/remove the existing file.", {
        color: Color.muted,
      }),
    ],
  };
  return renderFooterPanel(spec, width);
}
