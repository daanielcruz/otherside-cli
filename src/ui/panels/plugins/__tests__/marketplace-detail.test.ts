import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import {
  marketplaceDetailView,
  UPDATING_MARKETPLACE,
} from "@/ui/panels/plugins/marketplace-detail.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_WIDTH = 76;
const REFRESH_PROGRESS = "Refreshing marketplace cache (timeout: 120s)…";
const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

const marketplace: KnownMarketplace = {
  name: "probe-marketplace",
  source: "owner/probe",
  sourceType: "git",
  installLocation: "/nowhere/probe",
  lastUpdated: "2026-01-02T00:00:00.000Z",
};

function view(input: { busy: string | null; notice?: { text: string; isError: boolean } }) {
  return marketplaceDetailView({
    marketplace,
    installedPlugins: [],
    view: "details",
    selection: 0,
    contentWidth: CONTENT_WIDTH,
    busy: input.busy,
    notice: input.notice ?? null,
  });
}

describe("marketplace detail update progress", () => {
  it("names the work in the brand hue and asks for patience while it runs", () => {
    const { body, footerHints, ownsBusy } = view({ busy: UPDATING_MARKETPLACE });
    const plain = body.map(stripAnsi);

    expect(ownsBusy).toBe(true);
    expect(footerHints).toEqual([]);
    expect(body).toContain(renderTextWithStyles(UPDATING_MARKETPLACE, { color: Color.brand }));
    expect(body).toContain(
      renderTextWithStyles("Please wait…", { color: Color.muted, italic: true }),
    );
    // The action menu stays away until the refresh settles.
    expect(plain.some((line) => line.includes("Browse plugins"))).toBe(false);
    expect(plain.some((line) => line.includes("Remove marketplace"))).toBe(false);
  });

  it("keeps the engine's progress line under the headline", () => {
    const { body } = view({ busy: REFRESH_PROGRESS });
    const plain = body.map(stripAnsi);

    expect(plain).toContain(UPDATING_MARKETPLACE);
    expect(body).toContain(renderTextWithStyles(REFRESH_PROGRESS, { color: Color.muted }));
    expect(plain.indexOf(REFRESH_PROGRESS)).toBe(plain.indexOf(UPDATING_MARKETPLACE) + 1);
  });

  it("reports the finished refresh above the action menu it hands back", () => {
    const { body, ownsBusy } = view({
      busy: null,
      notice: { text: "Updated 1 marketplace", isError: false },
    });
    const plain = body.map(stripAnsi);

    expect(ownsBusy).toBeUndefined();
    expect(body).toContain(renderTextWithStyles("✔ Updated 1 marketplace", { color: Color.brand }));
    const notice = plain.findIndex((line) => line.includes("Updated 1 marketplace"));
    const menu = plain.findIndex((line) => line.includes("Browse plugins"));
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(menu).toBeGreaterThan(notice);
    expect(plain.some((line) => line.includes("Remove marketplace"))).toBe(true);
  });

  it("reads a failed refresh in the error hue", () => {
    const { body } = view({ busy: null, notice: { text: "git clone failed", isError: true } });
    expect(body).toContain(renderTextWithStyles("✘ git clone failed", { color: Color.error }));
  });
});
