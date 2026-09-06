import type { UserConfig } from "@/kernel/config/config.ts";
import type { ListPanelSpec } from "@/ui/chrome/string-view-panel.ts";
import { renderListPanel } from "@/ui/chrome/string-view-panel.ts";
import { loginFooterHints, type Phase, type ProviderRow } from "@/ui/panels/login/flow.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export function renderLoginList(input: {
  width: number;
  rows: ProviderRow[];
  cursor: number;
  phase: Phase;
  config: UserConfig | undefined;
  hasAnyCredential: boolean;
  terminalRows: number;
}): string[] {
  const { width, rows, cursor, phase, config, hasAnyCredential, terminalRows } = input;
  const configured = config?.defaultProvider !== undefined;
  const needsProvider = !hasAnyCredential && configured;
  const subtitle = needsProvider
    ? "⚠ At least one provider is required to continue."
    : "Choose a provider to authenticate.";
  const spec: ListPanelSpec = {
    command: "/login",
    title: "Sign in",
    subtitle,
    items: rows.map((row) => ({
      id: row.id,
      label: row.label,
      ...(row.signedIn ? { value: `· ${Glyph.checkThin}`, valueColor: Color.success } : {}),
    })),
    cursor,
    maxRows: terminalRows,
    footerHints: loginFooterHints(phase),
    rowWidth: 42,
    emptyLabel: "No providers available.",
  };
  return renderListPanel(spec, width);
}
