import { get as getToolHandler } from "@/engine/tools/registry.ts";
import { isMcpToolName } from "@/kernel/mcp/protocol/wire-name.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import wrapText from "@/terminal-runtime/text/line-fold.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import type { TranscriptPresentation } from "@/ui/transcript/presentation.ts";
import {
  bashHeaderCommand,
  displayRouteModelName,
  resolveArgBody,
  resolveArgSegments,
} from "@/ui/transcript/tool-render/args.ts";
import { wrapStyledRows } from "@/ui/transcript/tool-render/format.ts";
import { resolveToolLabel } from "@/ui/transcript/tool-render/label.ts";
import type { ToolEntryData } from "@/ui/transcript/tool-render/types.ts";

/** How long a live foreground tool holds each loader phase. */
export const TOOL_PULSE_INTERVAL_MS = 600;

/**
 * A live unresolved tool alternates between its bullet and a blank. Its row is rendered
 * in the live frame, so a blank phase cannot become settled scrollback.
 */
function isPulseVisible(data: ToolEntryData): boolean {
  if (data.status !== "running" || data.isBackgrounded === true) return true;
  if (data.elapsedMs === undefined) return true;
  return Math.floor(data.elapsedMs / TOOL_PULSE_INTERVAL_MS) % 2 === 0;
}

export function formatHeadRows(
  data: ToolEntryData,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  const hooks = getToolHandler(data.name)?.render;
  const displayedName = resolveToolLabel({
    name: data.name,
    args: data.args,
    mcpIdentity: data.mcpIdentity,
  });
  if (displayedName.length === 0) return [];

  const argSegments = resolveArgSegments(hooks, data.name, data.args);
  const bashCommand =
    data.name === "Bash"
      ? bashHeaderCommand(data.args, { full: presentation !== "compact" })
      : null;
  const argBody = resolveArgBody({ name: data.name, bashCommand, argSegments });
  const hasArgBody = bashCommand !== null ? bashCommand.length > 0 : argSegments.length > 0;
  const unresolved = data.status === "queued" || data.status === "running";
  const glyphColor = unresolved
    ? Color.muted
    : data.status === "error"
      ? Color.error
      : Color.success;
  const glyph = renderTextWithStyles(`${isPulseVisible(data) ? Glyph.bullet : " "} `, {
    color: glyphColor,
    dim: unresolved,
  });
  const name = renderTextWithStyles(displayedName, {
    bold: true,
    color: Color.titleStrong,
  });
  if (data.name === "Bash" && bashCommand !== null && bashCommand.length > 0) {
    return headRows({
      glyph,
      name,
      displayedName,
      body: bashCommand,
      suffix: "",
      width,
      singleRow: false,
    });
  }
  const showsProducer = data.name === "Agent" || data.name === "GenerateImage";
  const route =
    data.name === "Agent"
      ? (data.agentRoute ?? data.producerRoute)
      : showsProducer
        ? data.producerRoute
        : undefined;
  const routeLabel = route
    ? renderTextWithStyles(` ${displayRouteModelName(route)}`, { color: Color.muted })
    : "";

  return headRows({
    glyph,
    name,
    displayedName,
    body: hasArgBody ? argBody : "",
    suffix: routeLabel,
    width,
    // A server names its own arguments and can hand over a whole script, so this is
    // the one header whose length nothing upstream bounds: the summary keeps every
    // key it was given and the row is what decides how much of it is shown.
    singleRow: isMcpToolName(data.name),
  });
}

/**
 * The head row and whatever it wraps onto. Continuations line up under the tool's name,
 * so a long argument reads as one field instead of falling back to the left margin.
 *
 * The brackets wrap together with the body rather than being added to finished rows: a
 * row measured for the body alone and then given a bracket is one column past the
 * terminal, which folds that column onto a row of its own with none of the indent.
 *
 * `singleRow` spends the remaining columns and stops. It exists for arguments whose
 * length no earlier stage bounds — the field is then clipped to the row rather than
 * flowed onto more of them, so one call cannot bury the conversation above it.
 */
function headRows(input: {
  glyph: string;
  name: string;
  displayedName: string;
  body: string;
  suffix: string;
  width: number;
  singleRow: boolean;
}): string[] {
  const { glyph, name, displayedName, body, suffix, width, singleRow } = input;
  const head = `${glyph}${name}`;
  if (body.length === 0 && suffix.length === 0) return [head];
  const prefixWidth = stringWidth(`${Glyph.bullet} ${displayedName}`);
  const field =
    (body.length > 0 ? renderTextWithStyles(`(${body})`, { color: Color.toolBody }) : "") + suffix;
  const budget = Math.max(1, width - prefixWidth);
  // Clipping measures painted columns, so a wide glyph is never split in half and
  // the ellipsis lands on a boundary the terminal can render.
  if (singleRow) return [head + wrapText(field, budget, "truncate-end")];
  const rows = wrapStyledRows(field, budget);
  return rows.map((row, index) => (index === 0 ? head : " ".repeat(prefixWidth)) + row);
}
