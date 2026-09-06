import type { DeviceAuthPending } from "@/backend/shared/oauth.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type FooterPanelSpec,
  labelColumnWidth,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { LOGIN_PROVIDERS } from "@/ui/panels/remote/data.ts";
import { Color } from "@/ui/theme/theme.ts";

const COMMAND = "/remote";
const ROW_WIDTH = labelColumnWidth(LOGIN_PROVIDERS.map((provider) => provider.label));

export interface LoginPickState {
  providerIdx: number;
  busy: boolean;
  deviceAuth: DeviceAuthPending | null;
  error: string | null;
}

export function loginPickPanelLines(
  state: LoginPickState,
  width: number,
  contentWidth: number,
): string[] {
  const body: string[] = [
    renderTextWithStyles("Sign in to the otherside backend to link your mobile device.", {
      color: Color.muted,
    }),
    "",
  ];
  for (let idx = 0; idx < LOGIN_PROVIDERS.length; idx++) {
    const provider = LOGIN_PROVIDERS[idx]!;
    body.push(
      renderPanelRowLine(
        { label: provider.label, selected: idx === state.providerIdx },
        contentWidth,
        ROW_WIDTH,
      ),
    );
  }
  if (state.busy) {
    body.push("");
    body.push(
      renderTextWithStyles("Opening browser… complete the sign-in, then return here.", {
        color: Color.muted,
        dim: true,
      }),
    );
  }
  if (state.deviceAuth !== null) {
    body.push("");
    body.push(
      renderTextWithStyles("Approve this terminal in the browser", { color: Color.warning }),
    );
    body.push(
      renderTextWithStyles("Code ", { color: Color.muted }) +
        renderTextWithStyles(state.deviceAuth.userCode, { color: Color.text, bold: true }),
    );
    body.push(renderTextWithStyles(state.deviceAuth.verificationUri, { color: Color.panelAccent }));
  }
  if (state.error) {
    body.push("");
    body.push(renderTextWithStyles(state.error, { color: Color.error }));
  }

  const spec: FooterPanelSpec = {
    command: COMMAND,
    title: "Sign in",
    footerHints: [
      ["↑↓", "navigate"],
      ["Enter", "choose"],
      ["Esc/←", "back"],
    ],
    body,
  };
  return renderFooterPanel(spec, width);
}
