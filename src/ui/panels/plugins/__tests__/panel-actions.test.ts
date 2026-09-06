import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPluginInstallation } from "@/engine/plugins/installations.ts";
import { type LoadedPlugin, loadPluginFromDirectory } from "@/engine/plugins/loader.ts";
import { addMarketplace } from "@/engine/plugins/marketplace.ts";
import { installMarketplacePlugin } from "@/engine/plugins/marketplace-install.ts";
import { removeKnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import { getTranscriptEntries, transcriptActions } from "@/store/transcript/index.ts";
import { PanelActions, type PanelHost } from "@/ui/panels/plugins/panel-actions.ts";
import {
  initialPanelState,
  type PanelState,
  withData,
  withMarketplaces,
} from "@/ui/panels/plugins/panel-state.ts";
import { publishPanelTranscriptLine } from "@/ui/panels/transcript-feedback.ts";

function makeHost(initial: PanelState): { host: PanelHost; current: () => PanelState } {
  let state = initial;
  return {
    host: {
      getState: () => state,
      setState: (next) => {
        state = next(state);
      },
      requestRender: () => {},
      isCancelled: () => false,
      close: () => {},
      setAuthAbort: () => {},
    },
    current: () => state,
  };
}

function makeActions(initial: PanelState): { actions: PanelActions; current: () => PanelState } {
  const { host, current } = makeHost(initial);
  const actions = new PanelActions(host, {
    refreshCatalog: async () => null,
    loadMcpConfig: async () => ({ config: { mcpServers: {} }, sources: {} }),
    loadDisabledMcp: async () => new Set<string>(),
  });
  return { actions, current };
}

async function settle(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) {
    await Bun.sleep(1);
  }
}

function baseState(): PanelState {
  return initialPanelState({ commandResult: null, favorites: new Set() });
}

describe("marketplace add lifecycle", () => {
  it("a pending add refuses a second submission", async () => {
    const pending = withData(withMarketplaces(baseState(), { addInput: "/somewhere" }), {
      busy: "Adding marketplace to configuration…",
    });
    const { actions, current } = makeActions(pending);

    actions.run({ kind: "submit-add-marketplace" });
    await Bun.sleep(5);

    expect(current().data.busy).toBe("Adding marketplace to configuration…");
    expect(current().marketplaces.addInput).toBe("/somewhere");
  });

  it("a failed add clears busy and closes the form", async () => {
    const missing = join(tmpdir(), "plugins-panel-missing-marketplace-xyz");
    const { actions, current } = makeActions(withMarketplaces(baseState(), { addInput: missing }));

    actions.run({ kind: "submit-add-marketplace" });
    await settle(() => current().data.busy === null && current().marketplaces.addInput === null);

    expect(current().data.busy).toBeNull();
    expect(current().marketplaces.addInput).toBeNull();
  });
});

describe("plugin install transcript feedback", () => {
  it("a failed install batch reports through the transcript and keeps the panel open", async () => {
    transcriptActions.clear();
    let closed = false;
    const { host } = ((): { host: PanelHost } => {
      let state = baseState();
      return {
        host: {
          getState: () => state,
          setState: (next) => {
            state = next(state);
          },
          requestRender: () => {},
          isCancelled: () => false,
          close: () => {
            closed = true;
          },
          setAuthAbort: () => {},
        },
      };
    })();
    const actions = new PanelActions(host, {
      refreshCatalog: async () => null,
      loadMcpConfig: async () => ({ config: { mcpServers: {} }, sources: {} }),
      loadDisabledMcp: async () => new Set<string>(),
    });

    actions.run({
      kind: "install-batch",
      items: [
        {
          marketplace: "no-such-marketplace-xyz",
          entry: { name: "ghost-plugin", source: "./ghost" },
        } as never,
      ],
      scope: "user",
    });
    await settle(() => getTranscriptEntries().length > 0);

    const entries = getTranscriptEntries();
    expect(entries[0]?.kind).toBe("user");
    expect(entries[0]?.text).toBe("/plugins");
    expect(entries[1]?.kind).toBe("command_output");
    expect(entries[1]?.isError).toBe(true);
    expect(entries[1]?.text).toContain("no-such-marketplace-xyz");
    expect(closed).toBe(false);
    transcriptActions.clear();
  });

  it("publishPanelTranscriptLine anchors the result under its command", () => {
    transcriptActions.clear();
    publishPanelTranscriptLine("/plugins", "✓ Installed 1 plugin. Run /reload to activate.");
    publishPanelTranscriptLine("/plugins", "second result");
    const entries = getTranscriptEntries();
    expect(entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user", "/plugins"],
      ["command_output", "✓ Installed 1 plugin. Run /reload to activate."],
      ["command_output", "second result"],
    ]);
    expect(entries[1]?.settlementState).toBe("settled");
    expect(entries[1]?.isError).toBeUndefined();
    transcriptActions.clear();
  });
});

describe("uninstall in-panel feedback", () => {
  const PLUGIN = "uninstall-probe";
  const MARKETPLACE = "uninstall-probe-marketplace";

  async function installProbePlugin(): Promise<LoadedPlugin> {
    const marketplaceDir = mkdtempSync(join(tmpdir(), "plugins-uninstall-"));
    mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(marketplaceDir, PLUGIN), { recursive: true });
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: MARKETPLACE, plugins: [{ name: PLUGIN, source: `./${PLUGIN}` }] }),
    );
    writeFileSync(
      join(marketplaceDir, PLUGIN, "plugin.json"),
      JSON.stringify({ name: PLUGIN, version: "1.0.0" }),
    );
    const added = await addMarketplace(marketplaceDir);
    if (!added.ok) throw new Error(`probe marketplace not added: ${added.error}`);
    const installed = installMarketplacePlugin(MARKETPLACE, PLUGIN, "user");
    if (!installed.success) throw new Error(`probe plugin not installed: ${installed.message}`);
    const identity = `${PLUGIN}@${MARKETPLACE}`;
    const installation = findPluginInstallation(identity);
    const plugin = installation
      ? loadPluginFromDirectory(installation.installPath, identity)
      : null;
    if (!plugin) throw new Error("probe plugin did not load");
    return plugin;
  }

  it("reports a finished uninstall inside the panel and leaves the transcript alone", async () => {
    transcriptActions.clear();
    const plugin = await installProbePlugin();
    const { actions, current } = makeActions(baseState());

    actions.run({ kind: "run-detail-action", plugin, actionId: "uninstall" });
    await settle(() => current().data.commandResult !== null);

    expect(current().data.commandResult).toBe(`Uninstalled ${PLUGIN}. Run /reload to activate.`);
    expect(current().installed.detail.kind).toBe("list");
    expect(current().data.uninstalled.has(`${PLUGIN}@${MARKETPLACE}`)).toBe(true);
    expect(current().data.busy).toBeNull();
    expect(getTranscriptEntries()).toHaveLength(0);
    removeKnownMarketplace(MARKETPLACE);
  });
});

describe("marketplace update feedback", () => {
  const MISSING_SOURCE = join(tmpdir(), "definitely-missing-marketplace-dir-xyz");

  it("an update run from the roster anchors its failure under /plugins", async () => {
    transcriptActions.clear();
    const { actions } = makeActions(baseState());
    actions.run({ kind: "update-marketplace", source: MISSING_SOURCE, inDetail: false });
    await settle(() => getTranscriptEntries().length >= 2);
    const entries = getTranscriptEntries();
    expect(entries[0]?.kind).toBe("user");
    expect(entries[0]?.text).toBe("/plugins");
    expect(entries[1]?.kind).toBe("command_output");
    expect(entries[1]?.isError).toBe(true);
    transcriptActions.clear();
  });

  it("an update run from the detail screen keeps its outcome in the panel", async () => {
    transcriptActions.clear();
    const detail = withMarketplaces(baseState(), { view: "details" });
    const { actions, current } = makeActions(detail);

    actions.run({ kind: "update-marketplace", source: MISSING_SOURCE, inDetail: true });
    await settle(() => current().marketplaces.detailNotice !== null);

    expect(current().marketplaces.detailNotice?.isError).toBe(true);
    expect(current().data.busy).toBeNull();
    expect(getTranscriptEntries()).toHaveLength(0);
  });
});
