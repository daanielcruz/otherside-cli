import { capitalize } from "@/kernel/std/text/text.ts";
import { wrapProse, wrapUrlLink } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { type FooterPanelSpec, renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import type { McpAuthState, McpAuthStatus } from "@/ui/panels/mcp/authentication.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;

export function renderMcpAuth(auth: McpAuthState, width: number): string[] {
  const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
  const body: string[] = [];

  body.push(
    renderTextWithStyles(`Authenticate ${capitalize(auth.serverName)}`, {
      color: Color.textStrong,
      bold: true,
    }),
  );
  body.push(renderTextWithStyles(auth.serverName, { color: Color.muted }));
  body.push("");

  if (auth.status === "running") {
    if (auth.url.length > 0) {
      body.push(
        ...wrapProse(
          ` Browser didn't open? Use the url below to sign in (${auth.urlCopied ? "Copied!" : "c to copy"})`,
          contentWidth,
        ).map((line) => renderTextWithStyles(line, { color: Color.muted })),
      );
      body.push("");
      for (const line of wrapUrlLink(auth.url, contentWidth)) {
        body.push(renderTextWithStyles(line, { color: Color.panelAccent }));
      }
      body.push("");
      body.push("");
      body.push(
        renderTextWithStyles("Or paste the URL/code from the redirect page:", {
          color: Color.muted,
        }),
      );
      body.push(
        renderTextWithStyles(Glyph.chevron, { color: Color.muted }) +
          renderTextWithStyles(`${auth.pasted}${Glyph.blockHalf}`, { color: Color.text }),
      );
      body.push("");
    }
    body.push(renderTextWithStyles(auth.message, { color: authStatusColor(auth.status) }));
  } else {
    body.push(renderTextWithStyles(auth.message, { color: authStatusColor(auth.status) }));
  }

  const spec: FooterPanelSpec = {
    command: "/mcp",
    footerHints:
      auth.status === "running"
        ? [
            ["Enter", "submit code"],
            ["Esc", "cancel"],
          ]
        : [
            ["Enter", "back"],
            ["Esc", "back"],
          ],
    body,
  };
  return renderFooterPanel(spec, width);
}

function authStatusColor(status: McpAuthStatus): TerminalColor {
  if (status === "ok") return Color.success;
  if (status === "fail") return Color.error;
  return Color.panelAccent;
}
