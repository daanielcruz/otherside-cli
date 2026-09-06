import { displayMcpServerName, type McpToolInfo, wireToolName } from "@/kernel/mcp/index.ts";
import { computeItemCountWindow } from "@/kernel/std/list-window.ts";
import { capitalize } from "@/kernel/std/text/text.ts";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import { type McpServerRow, serverMenuOptions, TOOL_PAGE_SIZE } from "@/ui/panels/mcp/data.ts";
import { serverInfoLines } from "@/ui/panels/mcp/server-detail.ts";
import {
  annotationLabels,
  clipWithCount,
  PARAM_DESCRIPTION_MAX_CHARS,
  schemaProperties,
  TOOL_DESCRIPTION_MAX_CHARS,
  toolDisplayName,
} from "@/ui/panels/mcp/tool-format.ts";
import {
  DETAIL_ROW_WIDTH,
  MCP_DETAILS_HINTS,
  MCP_TOOL_HINTS,
  MENU_ROW_WIDTH,
  type PanelDetailView,
} from "@/ui/panels/plugins/chrome.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/** One MCP server: what it is, and what can be done to it. Work in flight replaces both. */
export function mcpDetailView(input: {
  server: McpServerRow;
  contentWidth: number;
  busy: string | null;
  menuIndex: number;
}): PanelDetailView {
  const { server, contentWidth, busy, menuIndex } = input;
  const body: string[] = [];
  body.push(
    renderTextWithStyles(`${capitalize(displayMcpServerName(server.name))} MCP Server`, {
      color: Color.panelAccent,
      bold: true,
    }),
  );
  body.push("");
  if (busy) {
    body.push(renderTextWithStyles(busy, { color: Color.muted }));
  } else {
    for (const line of serverInfoLines(server, contentWidth)) body.push(line);
    body.push("");
    const options = serverMenuOptions(server);
    if (options.length === 0) {
      body.push(renderTextWithStyles("No actions available", { color: Color.muted }));
    } else {
      for (let i = 0; i < options.length; i++) {
        body.push(
          renderPanelRowLine(
            { label: `${i + 1}. ${options[i]!.label}`, selected: i === menuIndex },
            contentWidth,
            MENU_ROW_WIDTH,
          ),
        );
      }
    }
  }
  return { body, footerHints: busy ? [["Esc", "wait…"]] : MCP_DETAILS_HINTS };
}

/** The server's tools, windowed so a long roster stays one screenful. */
export function mcpToolsView(input: { server: McpServerRow; toolsIndex: number }): PanelDetailView {
  const { server, toolsIndex } = input;
  const tools = server.inspection.tools;
  const body: string[] = [];
  body.push(
    renderTextWithStyles(`Tools for ${server.name}`, { color: Color.panelAccent, bold: true }),
  );
  body.push(
    renderTextWithStyles(`${tools.length} tool${tools.length === 1 ? "" : "s"}`, {
      color: Color.muted,
    }),
  );
  body.push("");
  if (tools.length === 0) {
    body.push(renderTextWithStyles("No tools available", { color: Color.muted }));
  } else {
    // Shared item-count window: overflow markers come with the policy.
    const window = computeItemCountWindow({
      cursor: toolsIndex,
      total: tools.length,
      visibleCount: TOOL_PAGE_SIZE,
    });
    if (window.markerAbove !== undefined) {
      body.push(renderTextWithStyles(window.markerAbove, { color: Color.muted }));
    }
    for (let index = window.from; index < window.to; index++) {
      const tool = tools[index]!;
      const selected = index === toolsIndex;
      const marker = selected ? Glyph.chevron.trimEnd() : " ";
      const labels = annotationLabels(tool).join(", ");
      body.push(
        renderTextWithStyles(`${marker} `, {
          color: selected ? Color.panelAccent : Color.muted,
        }) +
          renderTextWithStyles(`${index + 1}. ${toolDisplayName(tool)}`, {
            color: selected ? Color.panelAccent : Color.text,
          }) +
          (labels.length > 0 ? renderTextWithStyles(` ${labels}`, { color: Color.muted }) : ""),
      );
    }
    if (window.markerBelow !== undefined) {
      body.push(renderTextWithStyles(window.markerBelow, { color: Color.muted }));
    }
  }
  return {
    body,
    footerHints:
      tools.length === 0
        ? [["Esc", "back"]]
        : [
            ["↑/↓", "navigate"],
            ["Enter", "detail"],
            ["Esc", "back"],
          ],
  };
}

/** One tool: the name it answers to on the wire, what it does, and what it takes. */
export function mcpToolDetailView(input: {
  server: McpServerRow;
  tool: McpToolInfo;
  contentWidth: number;
}): PanelDetailView {
  const { server, tool, contentWidth } = input;
  const body: string[] = [];
  let title = renderTextWithStyles(toolDisplayName(tool), {
    color: Color.panelAccent,
    bold: true,
  });
  for (const label of annotationLabels(tool)) {
    title += renderTextWithStyles(` [${label}]`, { color: Color.muted });
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
      { label: "Full name", value: wireToolName(server.name, tool.name), muted: true },
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
      const desc =
        param.description.length > 0
          ? ` - ${clipWithCount(param.description, PARAM_DESCRIPTION_MAX_CHARS)}`
          : "";
      const line = `${Glyph.bulletFilled} ${param.name}${required}: ${param.type}${desc}`;
      for (const wrapped of wrapProse(line, contentWidth)) {
        body.push(renderTextWithStyles(wrapped, { color: Color.muted }));
      }
    }
  }
  return { body, footerHints: MCP_TOOL_HINTS };
}
