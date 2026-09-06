import { displayMcpServerName, type McpToolInfo, wireToolName } from "@/kernel/mcp/index.ts";
import { computeItemCountWindow } from "@/kernel/std/list-window.ts";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import {
  type FooterPanelSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { formatCount, type McpServerRow, TOOL_PAGE_SIZE } from "@/ui/panels/mcp/data.ts";
import {
  annotationLabels,
  clipWithCount,
  PARAM_DESCRIPTION_MAX_CHARS,
  schemaProperties,
  TOOL_DESCRIPTION_MAX_CHARS,
  toolDisplayName,
} from "@/ui/panels/mcp/tool-format.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const DETAIL_ROW_WIDTH = 18;

export function renderMcpToolsList(input: {
  server: McpServerRow;
  toolIndex: number;
  terminalRows: number;
  width: number;
}): string[] {
  const { server, toolIndex, terminalRows, width } = input;
  const tools = server.inspection.tools;
  const body: string[] = [];

  // Shared item-count window: markers and the (N/M) counter come with it.
  const window = computeItemCountWindow({
    cursor: toolIndex,
    total: tools.length,
    visibleCount: TOOL_PAGE_SIZE,
  });

  body.push(
    renderTextWithStyles(`Tools for ${server.name} ${window.counter}`, {
      color: Color.panelAccent,
      bold: true,
    }),
  );
  body.push(renderTextWithStyles(formatCount(tools.length, "tool"), { color: Color.muted }));
  body.push("");

  if (tools.length === 0) {
    body.push(renderTextWithStyles("No tools available", { color: Color.muted }));
  } else {
    const numberWidth = `${tools.length}.`.length + 1;
    const nameWidth = Math.max(0, ...tools.map((tool) => toolDisplayName(tool).length)) + 2;

    if (window.markerAbove !== undefined) {
      body.push(renderTextWithStyles(window.markerAbove, { color: Color.muted }));
    }
    for (let index = window.from; index < window.to; index++) {
      const tool = tools[index]!;
      const selected = index === toolIndex;
      const marker = selected ? Glyph.chevron.trimEnd() : " ";
      const labels = annotationLabels(tool).join(", ");
      const number = `${index + 1}.`.padEnd(numberWidth);
      const name = toolDisplayName(tool).padEnd(nameWidth);
      const markerStyled = renderTextWithStyles(`${marker} `, {
        color: selected ? Color.panelAccent : Color.muted,
      });
      const numberStyled = renderTextWithStyles(number, { color: Color.muted });
      const nameStyled = renderTextWithStyles(name, {
        color: selected ? Color.panelAccent : Color.text,
      });
      const labelsStyled =
        labels.length > 0 ? renderTextWithStyles(labels, { color: Color.muted }) : "";
      body.push(markerStyled + numberStyled + nameStyled + labelsStyled);
    }
    if (window.markerBelow !== undefined) {
      body.push(renderTextWithStyles(window.markerBelow, { color: Color.muted }));
    }
  }

  const spec: FooterPanelSpec = {
    command: "/mcp",
    footerHints:
      tools.length === 0
        ? [["Esc", "back"]]
        : [
            ["↑/↓", "navigate"],
            ["Enter", "detail"],
            ["Esc", "back"],
          ],
    maxRows: terminalRows,
    body,
  };
  return renderFooterPanel(spec, width);
}

export function renderMcpToolDetail(input: {
  server: McpServerRow;
  tool: McpToolInfo;
  terminalRows: number;
  width: number;
}): string[] {
  const { server, tool, terminalRows, width } = input;
  const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
  const body: string[] = [];
  const annotations = annotationLabels(tool);

  let title = renderTextWithStyles(toolDisplayName(tool), {
    color: Color.panelAccent,
    bold: true,
  });
  for (const label of annotations) {
    title += renderTextWithStyles(` [${label}]`, { color: annotationColor(label) });
  }
  body.push(title);
  body.push(renderTextWithStyles(displayMcpServerName(server.name), { color: Color.muted }));
  body.push("");

  body.push(
    renderPanelRowLine(
      { label: "Tool name", value: tool.name, muted: true },
      contentWidth,
      DETAIL_ROW_WIDTH,
    ),
  );
  body.push(
    renderPanelRowLine(
      {
        label: "Full name",
        value: wireToolName(server.name, tool.name),
        muted: true,
      },
      contentWidth,
      DETAIL_ROW_WIDTH,
    ),
  );

  if (tool.description.length > 0) {
    body.push("");
    body.push(renderTextWithStyles("Description", { bold: true, color: Color.text }));
    const clipped = clipWithCount(tool.description, TOOL_DESCRIPTION_MAX_CHARS);
    for (const line of wrapProse(clipped, contentWidth)) {
      body.push(renderTextWithStyles(line, { color: Color.text }));
    }
  }

  const params = schemaProperties(tool.inputSchema);
  if (params.length > 0) {
    body.push("");
    body.push(renderTextWithStyles("Parameters", { bold: true, color: Color.text }));
    for (const param of params) {
      const required = param.required ? " (required)" : "";
      const description =
        param.description.length > 0
          ? ` - ${clipWithCount(param.description, PARAM_DESCRIPTION_MAX_CHARS)}`
          : "";
      const line = `${Glyph.bulletFilled} ${param.name}${required}: ${param.type}${description}`;
      for (const wrapped of wrapProse(line, contentWidth)) {
        body.push(renderTextWithStyles(wrapped, { color: Color.muted }));
      }
    }
  }

  const spec: FooterPanelSpec = {
    command: "/mcp",
    footerHints: [["Esc", "back"]],
    maxRows: terminalRows,
    body,
  };
  return renderFooterPanel(spec, width);
}

function annotationColor(label: string): TerminalColor {
  if (label === "destructive") return Color.error;
  if (label === "read-only") return Color.success;
  return Color.muted;
}
