import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { pluginDetailView } from "@/ui/panels/plugins/plugin-detail.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_WIDTH = 76;
const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

function probePlugin(): LoadedPlugin {
  return {
    name: "detail-probe",
    path: "/nowhere/detail-probe",
    source: "probe-marketplace",
    manifest: { name: "detail-probe" },
  };
}

function rowFor(lines: readonly string[], label: string): string {
  const row = lines.find((line) => stripAnsi(line).includes(label));
  if (row === undefined) throw new Error(`row not rendered: ${label}`);
  return row;
}

describe("installed plugin detail colours", () => {
  const actions = [
    { id: "toggle", label: "Disable plugin" },
    { id: "update", label: "Update now" },
    { id: "uninstall", label: "Uninstall" },
  ];

  it("reads Uninstall as destructive and Update as the offered action, cursor or not", () => {
    const { body } = pluginDetailView({
      plugin: probePlugin(),
      contentWidth: CONTENT_WIDTH,
      actions,
      actionIndex: 0,
      notice: null,
    });

    expect(rowFor(body, "Uninstall")).toContain(
      renderTextWithStyles("Uninstall", { color: Color.error, bold: false }),
    );
    expect(rowFor(body, "Update now")).toContain(
      renderTextWithStyles("Update now", { color: Color.panelAccent, bold: false }),
    );
  });

  it("keeps the action's own hue under the cursor and only adds weight", () => {
    const { body } = pluginDetailView({
      plugin: probePlugin(),
      contentWidth: CONTENT_WIDTH,
      actions,
      actionIndex: 2,
      notice: null,
    });

    expect(rowFor(body, "Uninstall")).toContain(
      renderTextWithStyles("Uninstall", { color: Color.error, bold: true }),
    );
  });

  it("paints an enabled status green and a disabled one as a warning", () => {
    const { body } = pluginDetailView({
      plugin: probePlugin(),
      contentWidth: CONTENT_WIDTH,
      actions,
      actionIndex: 0,
      notice: null,
    });
    const status = rowFor(body, "Status");
    const enabled = stripAnsi(status).includes("Enabled");
    expect(status).toContain(
      renderTextWithStyles(enabled ? "Enabled" : "Disabled", {
        color: enabled ? Color.success : Color.warning,
      }),
    );
  });
});
