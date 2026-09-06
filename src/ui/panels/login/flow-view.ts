import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import { wrapProse, wrapUrlLink } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type FooterPanelSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import {
  API_KEY_HOST_LABELS,
  formatContextWindow,
  formatOutputTokenLimit,
  inputDisplay,
  loginFooterHints,
  maskKey,
  OPENAI_CUSTOM_URL_PLACEHOLDER,
  oauthStatusColor,
  type Phase,
} from "@/ui/panels/login/flow.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export function renderLoginFlow(phase: Exclude<Phase, { kind: "list" }>, width: number): string[] {
  const contentWidth = Math.max(1, width - 4);
  const body = loginFlowBody(phase, contentWidth);
  const title = phase.kind === "custom" ? "OpenAI Custom" : "Sign in";
  const spec: FooterPanelSpec = {
    command: "/login",
    title,
    footerHints: loginFooterHints(phase),
    body,
    flushTop: true,
  };
  return renderFooterPanel(spec, width);
}

function loginFlowBody(phase: Exclude<Phase, { kind: "list" }>, contentWidth: number): string[] {
  if (phase.kind === "oauth") return oauthBody(phase, contentWidth);
  if (phase.kind === "verify") return verifyBody(phase, contentWidth);
  if (phase.kind === "api_key") return apiKeyBody(phase, contentWidth);
  return customBody(phase, contentWidth);
}

function oauthBody(phase: Extract<Phase, { kind: "oauth" }>, contentWidth: number): string[] {
  const lines: string[] = [];
  const tos = tosWarningLine(phase.provider.id as ProviderId);
  if (tos) lines.push(tos, "");
  lines.push(renderTextWithStyles(phase.provider.label, { color: Color.muted }));
  const color = oauthStatusColor(phase.status);
  if (phase.status === "running") {
    if (phase.url.length > 0) {
      lines.push("");
      lines.push(
        ...wrapProse(
          ` Browser didn't open? Use the url below to sign in (${phase.urlCopied ? "Copied!" : "c to copy"})`,
          contentWidth,
        ).map((row) => renderTextWithStyles(row, { color: Color.muted })),
      );
      lines.push("");
      lines.push(...oauthUrlRows(phase.url, contentWidth));
      lines.push("");
    }
    if (phase.supportsPaste) {
      lines.push("");
      lines.push(
        renderTextWithStyles("Or paste the URL/code from the redirect page:", {
          color: Color.muted,
        }),
      );
      lines.push(
        renderTextWithStyles(Glyph.chevron, { color: Color.muted }) +
          renderTextWithStyles(`${phase.pasted}${Glyph.blockHalf}`, { color: Color.text }),
      );
    }
    lines.push("");
    lines.push(renderTextWithStyles(phase.message, { color }));
  } else {
    lines.push("");
    lines.push(renderTextWithStyles(phase.message, { color }));
  }
  return lines;
}

function verifyBody(phase: Extract<Phase, { kind: "verify" }>, contentWidth: number): string[] {
  const color = phase.status === "fail" ? Color.error : Color.panelAccent;
  return [
    renderTextWithStyles(phase.provider.label, { color: Color.muted }),
    "",
    renderTextWithStyles(phase.description, { color: Color.text }),
    "",
    renderTextWithStyles("Verify your account in the browser, then return here:", {
      color: Color.muted,
    }),
    ...oauthUrlRows(phase.url, contentWidth),
    "",
    renderTextWithStyles(phase.message, { color }),
    "",
    renderTextWithStyles("Enter verified · a another account · Esc cancel", {
      color: Color.muted,
    }),
  ];
}

function apiKeyBody(phase: Extract<Phase, { kind: "api_key" }>, contentWidth: number): string[] {
  const host = API_KEY_HOST_LABELS[phase.provider];
  const lines: string[] = [
    renderTextWithStyles(`Paste your ${host} API key.`, { color: Color.muted }),
    "",
    renderPanelRowLine(
      {
        label: "API key",
        value: `${maskKey(phase.apiKey)}${phase.status === "input" ? Glyph.blockHalf : ""}`,
        selected: phase.status === "input",
      },
      contentWidth,
      14,
    ),
  ];
  if (phase.status === "fail") {
    lines.push(renderTextWithStyles(phase.message, { color: Color.error }));
  }
  if (phase.status === "saving") {
    lines.push(renderTextWithStyles("saving…", { color: Color.panelAccent }));
  }
  return lines;
}

function customBody(phase: Extract<Phase, { kind: "custom" }>, contentWidth: number): string[] {
  if (phase.step === "credentials") {
    const lines: string[] = [
      renderTextWithStyles("Enter the OpenAI-compatible base URL and optional API key.", {
        color: Color.muted,
      }),
      "",
      renderPanelRowLine(
        {
          label: "Base URL",
          value: inputDisplay(phase.url, OPENAI_CUSTOM_URL_PLACEHOLDER, phase.field === 0),
          valueColor: phase.url.length === 0 ? Color.muted : undefined,
          selected: phase.field === 0,
        },
        contentWidth,
        14,
      ),
      renderPanelRowLine(
        {
          label: "API key (optional)",
          value: `${maskKey(phase.apiKey)}${phase.field === 1 ? Glyph.blockHalf : ""}`,
          selected: phase.field === 1,
        },
        contentWidth,
        20,
      ),
    ];
    if (phase.status === "fail") {
      lines.push(renderTextWithStyles(phase.message, { color: Color.error }));
    }
    if (phase.status === "discovering") {
      lines.push(renderTextWithStyles(phase.message, { color: Color.panelAccent }));
    }
    return lines;
  }

  if (phase.step === "model") {
    const lines: string[] = [
      renderTextWithStyles(phase.message, {
        color: phase.failedDiscovery ? Color.error : Color.muted,
      }),
      "",
    ];
    if (phase.manual) {
      lines.push(
        renderPanelRowLine(
          {
            label: "Model",
            value: `${phase.model}${Glyph.blockHalf}`,
            selected: true,
          },
          contentWidth,
          14,
        ),
      );
    } else {
      for (let index = 0; index < phase.models.length; index++) {
        const model = phase.models[index]!;
        lines.push(
          renderPanelRowLine(
            {
              label: model.id,
              value: formatContextWindow(model.contextWindow),
              selected: phase.cursor === index,
              active: phase.model === model.id,
            },
            contentWidth,
            62,
          ),
        );
      }
      lines.push("");
      lines.push(
        renderPanelRowLine(
          {
            label: "Enter model manually",
            selected: phase.cursor >= phase.models.length,
          },
          contentWidth,
          42,
        ),
      );
    }
    return lines;
  }

  if (phase.step === "context") {
    return [
      renderTextWithStyles(phase.message, {
        color: phase.status === "fail" ? Color.error : Color.muted,
      }),
      "",
      renderPanelRowLine({ label: "Model", value: phase.model }, contentWidth, 18),
      renderPanelRowLine(
        {
          label: "Context window",
          value: `${phase.contextWindow}${Glyph.blockHalf}`,
          selected: true,
        },
        contentWidth,
        18,
      ),
    ];
  }

  if (phase.step === "output") {
    return [
      renderTextWithStyles(phase.message, {
        color: phase.status === "fail" ? Color.error : Color.muted,
      }),
      "",
      renderPanelRowLine({ label: "Model", value: phase.model }, contentWidth, 18),
      renderPanelRowLine(
        {
          label: "Max output",
          value: `${phase.outputTokenLimit}${Glyph.blockHalf}`,
          selected: true,
        },
        contentWidth,
        18,
      ),
    ];
  }

  if (phase.step === "test_failed") {
    return [
      renderTextWithStyles(phase.message, { color: Color.error }),
      "",
      renderPanelRowLine({ label: "Save anyway", selected: phase.cursor === 0 }, contentWidth, 22),
      renderPanelRowLine(
        { label: "Review settings", selected: phase.cursor === 1 },
        contentWidth,
        22,
      ),
    ];
  }

  return [
    renderTextWithStyles(phase.message, {
      color: phase.step === "success" ? Color.success : Color.panelAccent,
    }),
    "",
    renderPanelRowLine({ label: "Base URL", value: phase.url }, contentWidth, 14),
    renderPanelRowLine({ label: "Model", value: phase.model }, contentWidth, 14),
    renderPanelRowLine(
      {
        label: "Context",
        value: formatContextWindow(Number(phase.contextWindow)),
      },
      contentWidth,
      14,
    ),
    renderPanelRowLine(
      {
        label: "Max output",
        value: formatOutputTokenLimit(Number(phase.outputTokenLimit)),
      },
      contentWidth,
      14,
    ),
  ];
}

function oauthUrlRows(url: string, contentWidth: number): string[] {
  return wrapUrlLink(url, contentWidth).map((row) =>
    renderTextWithStyles(row, { color: Color.panelAccent }),
  );
}

function tosWarningLine(provider: ProviderId): string | null {
  if (provider !== "antigravity") return null;
  return renderTextWithStyles(
    `⚠ Using ${providerDisplayName(provider)} in third-party tools may violate Google's ToS. Please use at your own risk.`,
    { color: Color.warning, bold: true },
  );
}
