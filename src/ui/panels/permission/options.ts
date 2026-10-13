import { basename } from "node:path";
import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import {
  type PendingPermission,
  type PermissionResult,
  PermissionResults,
} from "@/kernel/channels/permission.ts";
import { parseRuleValueText } from "@/kernel/permissions/types.ts";
import { homeShortened } from "@/kernel/std/fs/paths.ts";
import { sharedGraphemeSegmenter } from "@/kernel/std/intl.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { displayNameFor } from "@/ui/transcript/tool-render/args.ts";

export type PermissionOptionKind =
  | "allow"
  | "allow_session"
  | "allow_session_tool"
  | "allow_session_edits"
  | "allow_always"
  | "deny";

/** A run of label text drawn with one emphasis. */
export interface LabelSegment {
  text: string;
  bold?: true;
}

export interface PermissionOptionRow {
  key: string;
  /** The plain label: every segment's text, joined. */
  label: string;
  kind: PermissionOptionKind;
  /**
   * The label split where emphasis changes, present when part of it is bold. A row
   * that carries segments wraps onto further lines; a plain row is cut to one line.
   */
  segments?: readonly LabelSegment[];
}

export interface PermissionOptionsInput {
  pending: Pick<
    PendingPermission,
    | "rule"
    | "rules"
    | "toolName"
    | "readOnly"
    | "readDirectories"
    | "writeDirectories"
    | "editDirectory"
    | "cwd"
  > &
    Partial<Pick<PendingPermission, "input">>;
  isDesign: boolean;
  mcp: { label: string; cwd: string } | null;
  /** Cells a grant that names the working directory may take on its one row. */
  grantLabelWidth: number;
}

type UnnumberedRow = Omit<PermissionOptionRow, "key">;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** How the session's accept-edits mode is named where an approval switches to it. */
const ACCEPT_EDITS_MODE = "accept edits (auto-approve file edits and common file commands)";

export function buildGenericOptions({
  pending,
  isDesign,
  mcp,
  grantLabelWidth,
}: PermissionOptionsInput): PermissionOptionRow[] {
  const rows = isDesign
    ? designRows(pending)
    : [
        plainRow("allow", "Yes"),
        ...approvalRows(pending, mcp, grantLabelWidth),
        denyRow(pending.toolName),
      ];
  return rows.map((row, index) => ({ key: String(index + 1), ...row }));
}

function designRows(pending: PermissionOptionsInput["pending"]): UnnumberedRow[] {
  const { rule, toolName } = pending;
  const rows = [plainRow("allow", "Allow once (this turn)")];
  if (rule) {
    rows.push(plainRow("allow_session", "Allow for this design session"));
    if (pending.readOnly) {
      rows.push(
        plainRow(
          "allow_session_tool",
          `Allow all ${userFacingToolName(toolName)} for this design session`,
        ),
      );
    }
    rows.push(plainRow("allow_always", `Always allow (persist for ${ruleDisplay(rule)})`));
  }
  rows.push(plainRow("deny", "Deny"));
  return rows;
}

/** The rows between "Yes" and "No": what a lasting or session-wide approval opens. */
function approvalRows(
  pending: PermissionOptionsInput["pending"],
  mcp: PermissionOptionsInput["mcp"],
  grantLabelWidth: number,
): UnnumberedRow[] {
  if (EDIT_TOOLS.has(pending.toolName)) return [sessionEditsRow(pending.editDirectory)];
  if (pending.toolName === "Read") return readRows(pending);
  if (pending.toolName === "Bash") return commandRows(pending);
  if (pending.toolName === "WebFetch") return fetchRows(pending.rule);
  return toolRows(pending, mcp, grantLabelWidth);
}

function sessionEditsRow(editDirectory: string | null | undefined): UnnumberedRow {
  if (editDirectory) {
    return styledRow("allow_session_edits", [
      { text: "Yes, allow all edits in " },
      { text: directoryName(editDirectory), bold: true },
      { text: " during this session" },
    ]);
  }
  return styledRow("allow_session_edits", [
    { text: "Yes, and switch to " },
    { text: ACCEPT_EDITS_MODE, bold: true },
    { text: " for this session " },
    { text: "(shift+tab)", bold: true },
  ]);
}

function readRows(pending: PermissionOptionsInput["pending"]): UnnumberedRow[] {
  const directories = pending.readDirectories ?? [];
  if (directories.length > 0) {
    return [
      styledRow("allow_session", [
        { text: "Yes, allow reading from " },
        ...boldList(directories),
        { text: " during this session" },
      ]),
    ];
  }
  return pending.rule ? [plainRow("allow_session", "Yes, during this session")] : [];
}

/**
 * A command's lasting approval. One rule and nothing else is offered as the editable
 * prefix; rules with the directories a command reads or writes are named together,
 * because the one approval saves them all.
 */
function commandRows(pending: PermissionOptionsInput["pending"]): UnnumberedRow[] {
  const rows: UnnumberedRow[] = [];
  const { rule } = pending;
  if (rule !== null && pending.readOnly) {
    rows.push(plainRow("allow_session", "Yes, during this session"));
  }
  if (rule !== null) {
    rows.push(plainRow("allow_always", `Yes, and don't ask again for: ${bashRuleContentOf(rule)}`));
    return rows;
  }
  const segments = commandGrantLabel({
    reads: pending.readDirectories ?? [],
    writes: pending.writeDirectories ?? [],
    commands: (pending.rules ?? []).map(commandRuleDisplay),
    cwd: pending.cwd ?? process.cwd(),
  });
  if (segments !== null) rows.push(styledRow("allow_always", segments));
  return rows;
}

function commandGrantLabel(grant: {
  reads: readonly string[];
  writes: readonly string[];
  commands: readonly string[];
  cwd: string;
}): LabelSegment[] | null {
  const { reads, writes, commands } = grant;
  const directories = [...writes, ...reads];
  if (commands.length === 0) {
    if (directories.length === 0) return null;
    if (writes.length === 0) {
      return [
        { text: "Yes, allow reading from " },
        ...boldList(reads),
        { text: " from this project" },
      ];
    }
    return [
      { text: "Yes, and always allow access to " },
      ...boldList(directories),
      { text: " from this project" },
    ];
  }
  if (directories.length === 0) {
    return [
      { text: "Yes, and don't ask again for " },
      ...boldList(commands),
      { text: " commands in " },
      { text: grant.cwd, bold: true },
    ];
  }
  if (directories.length === 1 && commands.length === 1) {
    return [
      { text: "Yes, and allow access to " },
      ...boldList(directories),
      { text: " and " },
      ...boldList(commands),
      { text: " commands" },
    ];
  }
  return [
    { text: "Yes, and allow " },
    ...boldList(directories),
    { text: " access and " },
    ...boldList(commands),
    { text: " commands" },
  ];
}

function fetchRows(rule: string | null): UnnumberedRow[] {
  const content = rule === null ? "" : (parseRuleValueText(rule)?.ruleContent ?? "");
  if (!content.startsWith("domain:")) return [];
  return [
    styledRow("allow_always", [
      { text: "Yes, and don't ask again for " },
      { text: content.slice("domain:".length), bold: true },
    ]),
  ];
}

function toolRows(
  pending: PermissionOptionsInput["pending"],
  mcp: PermissionOptionsInput["mcp"],
  grantLabelWidth: number,
): UnnumberedRow[] {
  const { rule, toolName } = pending;
  const rows: UnnumberedRow[] = [];
  if (rule === null) return rows;
  if (pending.readOnly) rows.push(plainRow("allow_session", "Yes, during this session"));
  // A rule naming the whole tool reads as every use of it in this directory.
  const wholeTool = mcp !== null || !parseRuleValueText(rule)?.ruleContent;
  if (!wholeTool) {
    rows.push(
      plainRow("allow_always", `Yes, and don't ask again for ${ruleDisplay(rule)} in this project`),
    );
    return rows;
  }
  const toolLabel = mcp?.label ?? displayNameFor(toolName, pending.input);
  const cwd = mcp?.cwd ?? pending.cwd ?? process.cwd();
  const label = wholeToolGrantLabel(toolLabel, cwd, grantLabelWidth);
  if (label !== null) rows.push(plainRow("allow_always", label));
  return rows;
}

/** A tool name this wide or wider leaves no room to name the directory, so no grant is offered. */
const GRANT_TOOL_LABEL_LIMIT = 48;
/** The narrowest budget a whole-tool grant is fitted into, however small the frame. */
const GRANT_LABEL_FLOOR = 24;

/**
 * "…for <tool> commands in <directory>" on one row: the directory as it is, else
 * with the home folder as `~`, else cut short with an ellipsis. Null when even the
 * shortest form cannot name the tool and a trace of the directory.
 */
function wholeToolGrantLabel(toolLabel: string, cwd: string, width: number): string | null {
  if (stringWidth(toolLabel) >= GRANT_TOOL_LABEL_LIMIT) return null;
  const budget = Math.max(GRANT_LABEL_FLOOR, width);
  const label = (place: string): string =>
    `Yes, and don't ask again for ${toolLabel} commands in ${place}`;
  const fits = (place: string): boolean => stringWidth(label(place)) <= budget;
  if (fits(cwd)) return label(cwd);
  const home = homeShortened(cwd);
  if (fits(home)) return label(home);
  let kept = "";
  for (const { segment } of sharedGraphemeSegmenter().segment(home)) {
    if (!fits(`${kept}${segment}…`)) break;
    kept += segment;
  }
  return kept.length > 0 ? label(`${kept}…`) : null;
}

function denyRow(toolName: string): UnnumberedRow {
  if (toolName !== "WebFetch") return plainRow("deny", "No");
  return styledRow("deny", [
    { text: "No, and tell Otherside what to do differently " },
    { text: "(esc)", bold: true },
  ]);
}

function plainRow(kind: PermissionOptionKind, label: string): UnnumberedRow {
  return { label, kind };
}

function styledRow(kind: PermissionOptionKind, segments: LabelSegment[]): UnnumberedRow {
  return { label: segments.map((segment) => segment.text).join(""), kind, segments };
}

/** `a`, `a and b`, or `a, b, and c`, each item bold. */
function boldList(items: readonly string[]): LabelSegment[] {
  const segments: LabelSegment[] = [];
  items.forEach((item, index) => {
    if (index > 0) {
      const last = index === items.length - 1;
      segments.push({ text: items.length === 2 ? " and " : last ? ", and " : ", " });
    }
    segments.push({ text: item, bold: true });
  });
  return segments;
}

export function resultFor(
  kind: PermissionOptionKind,
  rule: string | null,
  toolName: string,
  feedback: string,
  editDirectory: string | null | undefined,
  suggestions: PendingPermission["suggestions"],
  alwaysRules: readonly string[] = [],
): PermissionResult {
  if (kind === "allow") {
    return feedback.length > 0 ? PermissionResults.allow(feedback) : PermissionResults.allow();
  }
  if (kind === "deny") {
    return feedback.length > 0 ? PermissionResults.deny(feedback) : PermissionResults.deny();
  }
  if (kind === "allow_session" && (rule !== null || suggestions !== undefined)) {
    return withFeedback(PermissionResults.allowSession(rule, suggestions), feedback);
  }
  if (kind === "allow_session_tool" && toolName) {
    return withFeedback(PermissionResults.allowSession(toolName), feedback);
  }
  if (kind === "allow_session_edits") {
    const result =
      editDirectory === undefined
        ? PermissionResults.allowSessionEdits()
        : PermissionResults.allowSessionEdits(editDirectory);
    return withFeedback(result, feedback);
  }
  if (kind === "allow_always" && rule) {
    return withFeedback(PermissionResults.allowAlways(rule), feedback);
  }
  // Directory grants carry their rules with them, so they are saved as one approval.
  if (kind === "allow_always" && suggestions !== undefined && suggestions.length > 0) {
    return withFeedback({ decision: "allow", updates: suggestions }, feedback);
  }
  if (kind === "allow_always" && alwaysRules.length > 0) {
    return withFeedback(PermissionResults.allowAlwaysAll(alwaysRules), feedback);
  }
  if (kind === "allow_always") {
    return feedback.length > 0 ? PermissionResults.allow(feedback) : PermissionResults.allow();
  }
  return withFeedback(PermissionResults.deny(), feedback);
}

function withFeedback(result: PermissionResult, feedback: string): PermissionResult {
  const trimmed = feedback.trim();
  return trimmed.length > 0 ? { ...result, feedback: trimmed } : result;
}

export function bashRuleContentOf(rule: string): string {
  const openIdx = rule.indexOf("(");
  const closeIdx = rule.lastIndexOf(")");
  if (openIdx >= 0 && closeIdx > openIdx) return rule.slice(openIdx + 1, closeIdx).trim();
  const colonIdx = rule.indexOf(":");
  return colonIdx >= 0 ? rule.slice(colonIdx + 1).trim() : "";
}

/** A command rule as the command it allows: its content without a trailing wildcard. */
function commandRuleDisplay(rule: string): string {
  const content = bashRuleContentOf(rule);
  return content.endsWith(" *") || content.endsWith(":*") ? content.slice(0, -2) : content;
}

function directoryName(directory: string): string {
  return `${basename(directory) || directory}/`;
}

function ruleDisplay(rule: string): string {
  const value = parseRuleValueText(rule);
  if (value === null) return rule;
  const content = value.ruleContent?.trim() ?? "";
  if (content.length === 0) return value.toolName;
  const compact = content.length > 48 ? `${content.slice(0, 48)}…` : content;
  return `${value.toolName}(${compact})`;
}
