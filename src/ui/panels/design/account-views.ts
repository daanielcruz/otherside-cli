import type { DeviceAuthPending } from "@/backend/shared/oauth.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type FooterPanelSpec,
  labelColumnWidth,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { type Busy, busyLabel, deviceAuthLines, LOGIN_PROVIDERS } from "@/ui/panels/design/data.ts";
import { Color } from "@/ui/theme/theme.ts";

const ROW_WIDTH = labelColumnWidth(LOGIN_PROVIDERS.map((provider) => provider.label));
const CONTENT_PAD = 2;

export interface AccountViewState {
  providerIdx: number;
  busy: Busy;
  deviceAuth: DeviceAuthPending | null;
  error: string | null;
}

export function loginPickPanelLines(state: AccountViewState, width: number): string[] {
  const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
  const body: string[] = [
    renderTextWithStyles("Sign in to the otherside backend to relay your design session.", {
      color: Color.muted,
    }),
    "",
  ];
  for (let index = 0; index < LOGIN_PROVIDERS.length; index++) {
    const provider = LOGIN_PROVIDERS[index]!;
    body.push(
      renderPanelRowLine(
        { label: provider.label, selected: index === state.providerIdx },
        contentWidth,
        ROW_WIDTH,
      ),
    );
  }
  if (state.busy === "login") {
    body.push("");
    body.push(
      renderTextWithStyles("Opening browser… complete the sign-in, then return here.", {
        color: Color.muted,
        dim: true,
      }),
    );
  }
  if (state.deviceAuth !== null) {
    body.push(...deviceAuthLines(state.deviceAuth, contentWidth));
  }
  if (state.error) {
    body.push("");
    body.push(renderTextWithStyles(state.error, { color: Color.error }));
  }

  const spec: FooterPanelSpec = {
    command: "/design",
    title: "Sign in",
    footerHints: [
      ["↑↓", "navigate"],
      ["Enter", "choose"],
      ["Esc/←", "back"],
    ],
    body,
    flushTop: true,
  };
  return renderFooterPanel(spec, width);
}

export function logoutConfirmPanelLines(busy: Busy, width: number): string[] {
  const body: string[] = [
    renderTextWithStyles("Sign out of Otherside Design?", { color: Color.text }),
    "",
    renderTextWithStyles("This signs out every CLI session on this machine.", {
      color: Color.warning,
    }),
    renderTextWithStyles("Linked mobile devices are unpaired.", { color: Color.warning }),
    "",
    renderTextWithStyles("Enter to confirm · Esc to cancel", { color: Color.muted }),
  ];
  if (busy !== null) {
    body.push("");
    body.push(renderTextWithStyles(busyLabel(busy), { color: Color.muted, dim: true }));
  }

  const spec: FooterPanelSpec = {
    command: "/design",
    title: "Sign out",
    footerHints: [
      ["Enter", "confirm"],
      ["Esc/←", "cancel"],
    ],
    body,
    flushTop: true,
  };
  return renderFooterPanel(spec, width);
}
