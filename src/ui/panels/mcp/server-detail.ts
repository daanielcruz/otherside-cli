import { serverConfigLocation } from "@/kernel/mcp/config.ts";
import { displayMcpServerName } from "@/kernel/mcp/index.ts";
import { capitalize } from "@/kernel/std/text/text.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type FooterPanelSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import {
  capabilities,
  formatCount,
  hasOAuthToken,
  isRemote,
  type McpServerRow,
  serverMenuOptions,
} from "@/ui/panels/mcp/data.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const DETAIL_ROW_WIDTH = 18;
const MENU_ROW_WIDTH = 24;

export function renderMcpServerDetail(input: {
  server: McpServerRow;
  width: number;
  busy: string | null;
  menuIndex: number;
}): string[] {
  const { server, width, busy, menuIndex } = input;
  const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
  const body: string[] = [];
  const display = displayMcpServerName(server.name);

  body.push(
    renderTextWithStyles(`${capitalize(display)} MCP Server`, {
      color: Color.panelAccent,
      bold: true,
    }),
  );
  body.push("");

  if (busy) {
    body.push(renderTextWithStyles(`Reconnecting to ${display}`, { color: Color.text }));
    body.push(renderTextWithStyles("Restarting MCP server process", { color: Color.text }));
    body.push(
      renderTextWithStyles("This may take a few moments.", { color: Color.muted, italic: true }),
    );
  } else {
    for (const line of serverInfoLines(server, contentWidth)) body.push(line);
    body.push("");
    const options = serverMenuOptions(server);
    if (options.length === 0) {
      body.push(renderTextWithStyles("No actions available", { color: Color.muted }));
    } else {
      for (let index = 0; index < options.length; index++) {
        const option = options[index]!;
        body.push(
          renderPanelRowLine(
            {
              label: `${index + 1}. ${option.label}`,
              selected: index === menuIndex,
            },
            contentWidth,
            MENU_ROW_WIDTH,
          ),
        );
      }
    }
  }

  const spec: FooterPanelSpec = {
    command: "/mcp",
    footerHints: busy
      ? [["Esc", "wait…"]]
      : [
          ["↑/↓", "navigate"],
          ["Enter", "select"],
          ["Esc", "back"],
        ],
    body,
  };
  return renderFooterPanel(spec, width);
}

export function serverInfoLines(server: McpServerRow, contentWidth: number): string[] {
  const lines: string[] = [];
  const remote = isRemote(server.config);

  lines.push(
    renderPanelRowLine(
      { label: "Status", value: detailStatus(server) },
      contentWidth,
      DETAIL_ROW_WIDTH,
    ),
  );

  if (
    remote &&
    (server.inspection.status === "failed" || server.inspection.status === "needs-auth") &&
    server.inspection.error
  ) {
    lines.push(
      renderPanelRowLine(
        { label: "Issue", value: server.inspection.error, muted: true },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
  }

  if (remote) {
    lines.push(
      renderPanelRowLine(
        {
          label: "Auth",
          value: hasOAuthToken(server.name) ? "✔ authenticated" : "✘ not authenticated",
        },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
  }

  if (server.config.type === "stdio") {
    lines.push(
      renderPanelRowLine(
        { label: "Command", value: server.config.command, muted: true },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
    if (server.config.args.length > 0) {
      lines.push(
        renderPanelRowLine(
          { label: "Args", value: server.config.args.join(" "), muted: true },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
  } else {
    lines.push(
      renderPanelRowLine(
        { label: "URL", value: server.config.url, muted: true },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
  }

  lines.push(
    renderPanelRowLine(
      {
        label: "Config location",
        value: serverConfigLocation(process.cwd(), server.source),
        muted: true,
      },
      contentWidth,
      DETAIL_ROW_WIDTH,
    ),
  );

  if (server.inspection.status === "connected") {
    lines.push(
      renderPanelRowLine(
        { label: "Capabilities", value: capabilities(server) },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
    if (server.inspection.tools.length > 0) {
      lines.push(
        renderPanelRowLine(
          {
            label: "Tools",
            value: formatCount(server.inspection.tools.length, "tool"),
            muted: true,
          },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
    if (server.inspection.toolsError && server.inspection.error) {
      lines.push(
        renderPanelRowLine(
          { label: "Issue", value: server.inspection.error, muted: true },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
  }

  return lines;
}

function detailStatus(server: McpServerRow): string {
  const inspection = server.inspection;
  if (!server.enabled || inspection.status === "disabled") return "◯ disabled";
  if (inspection.status === "untrusted") return "⚠ untrusted";
  if (inspection.status === "needs-auth") return "△ needs authentication";
  if (inspection.status === "pending") return "◯ connecting…";
  if (inspection.status === "failed") return "✘ failed";
  if (inspection.toolsError) return "△ connected · tools fetch failed";
  if (inspection.tools.length === 0) return "△ connected · no tools";
  return "✔ connected";
}
