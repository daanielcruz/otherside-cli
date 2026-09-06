import { wrapIndex } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { serverMenuOptions } from "@/ui/panels/mcp/data.ts";
import { INSTALL_SCOPES } from "@/ui/panels/plugins/discover-detail.ts";
import {
  type KeyOutcome,
  outcome,
  type PanelModelReader,
} from "@/ui/panels/plugins/panel-keys-support.ts";
import {
  backInstalledDetail,
  type PanelState,
  resetForTab,
  withDiscover,
  withInstalled,
  withMarketplaces,
  withNav,
} from "@/ui/panels/plugins/panel-state.ts";
import { installedDetailActions } from "@/ui/panels/plugins/plugin-detail.ts";
import { SKILL_STATE_ORDER } from "@/ui/panels/plugins/skill-detail.ts";

/**
 * Keys belonging to a drill-down rather than a list: the add-marketplace prompt,
 * the discover install sheet, the installed detail stack, and the marketplace
 * sub-views. Each answers `undefined` for a key it does not claim.
 */

export function addMarketplaceKey(state: PanelState, key: KeyEventData): KeyOutcome | undefined {
  // A text draft, so these keys are the draft's rather than the panel's: they
  // accept and abandon what is being typed, and never move a panel level.
  if (key.name === "return") return outcome(state, { kind: "submit-add-marketplace" });
  if (key.name === "left" || key.name === "escape") {
    return outcome(withMarketplaces(state, { addInput: null }));
  }
  if (key.name === "backspace" || key.name === "delete") {
    return outcome(
      withMarketplaces(state, { addInput: (state.marketplaces.addInput ?? "").slice(0, -1) }),
    );
  }
  const sequence = key.sequence;
  if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
    return outcome(
      withMarketplaces(state, { addInput: (state.marketplaces.addInput ?? "") + sequence }),
    );
  }
  return undefined;
}

export function discoverDetailsKey(state: PanelState, key: KeyEventData): KeyOutcome | undefined {
  const item = state.discover.details;
  if (!item) return undefined;
  if (panelKey(key) === "back") {
    return outcome(withDiscover(state, { details: null, optionIndex: 0 }));
  }
  const optionCount = INSTALL_SCOPES.length + (item.entry.homepage ? 1 : 0);
  if (key.name === "up") {
    return outcome(
      withDiscover(state, {
        optionIndex: (state.discover.optionIndex + optionCount - 1) % optionCount,
      }),
    );
  }
  if (key.name === "down") {
    return outcome(
      withDiscover(state, { optionIndex: (state.discover.optionIndex + 1) % optionCount }),
    );
  }
  if (panelKey(key) === "confirm") {
    if (state.discover.optionIndex < INSTALL_SCOPES.length) {
      const scope = INSTALL_SCOPES[state.discover.optionIndex] ?? "user";
      return outcome(state, { kind: "install-batch", items: [item], scope });
    }
    if (item.entry.homepage) {
      return outcome(state, { kind: "open-browser", url: item.entry.homepage });
    }
  }
  return undefined;
}

export function installedDetailKey(state: PanelState, key: KeyEventData): KeyOutcome | undefined {
  if (panelKey(key) === "back") return outcome(backInstalledDetail(state));
  const detail = state.installed.detail;
  if (detail.kind === "plugin") {
    const actions = installedDetailActions(detail.plugin, state.data.favorites);
    if (key.name === "up") {
      return outcome(
        withInstalled(state, {
          actionIndex: wrapIndex(state.installed.actionIndex - 1, actions.length),
        }),
      );
    }
    if (key.name === "down") {
      return outcome(
        withInstalled(state, {
          actionIndex: wrapIndex(state.installed.actionIndex + 1, actions.length),
        }),
      );
    }
    if (panelKey(key) === "confirm") {
      const action = actions[Math.min(state.installed.actionIndex, actions.length - 1)];
      if (action) {
        return outcome(state, {
          kind: "run-detail-action",
          plugin: detail.plugin,
          actionId: action.id,
        });
      }
    }
    return undefined;
  }
  if (detail.kind === "skill") {
    const states = [
      detail.item.state,
      ...SKILL_STATE_ORDER.filter((candidate) => candidate !== detail.item.state),
    ];
    if (key.name === "up") {
      return outcome(
        withInstalled(state, {
          skillStateIndex: wrapIndex(state.installed.skillStateIndex - 1, states.length),
        }),
      );
    }
    if (key.name === "down") {
      return outcome(
        withInstalled(state, {
          skillStateIndex: wrapIndex(state.installed.skillStateIndex + 1, states.length),
        }),
      );
    }
    if (panelKey(key) === "confirm") {
      const chosen = states[Math.min(state.installed.skillStateIndex, states.length - 1)];
      if (chosen) {
        return outcome(state, { kind: "apply-skill-state", item: detail.item, state: chosen });
      }
    }
    return undefined;
  }
  if (detail.kind === "mcp") {
    const options = serverMenuOptions(detail.server);
    if (key.name === "up") {
      return outcome(
        withInstalled(state, {
          mcpMenuIndex: wrapIndex(state.installed.mcpMenuIndex - 1, Math.max(1, options.length)),
        }),
      );
    }
    if (key.name === "down") {
      return outcome(
        withInstalled(state, {
          mcpMenuIndex: wrapIndex(state.installed.mcpMenuIndex + 1, Math.max(1, options.length)),
        }),
      );
    }
    if (panelKey(key) === "confirm") {
      const option = options[Math.min(state.installed.mcpMenuIndex, options.length - 1)];
      if (option) {
        return outcome(state, {
          kind: "run-mcp-option",
          server: detail.server,
          optionId: option.id,
        });
      }
    }
    return undefined;
  }
  if (detail.kind === "mcp-tools") {
    const tools = detail.server.inspection.tools;
    if (key.name === "up") {
      return outcome(
        withInstalled(state, {
          mcpToolsIndex: wrapIndex(state.installed.mcpToolsIndex - 1, Math.max(1, tools.length)),
        }),
      );
    }
    if (key.name === "down") {
      return outcome(
        withInstalled(state, {
          mcpToolsIndex: wrapIndex(state.installed.mcpToolsIndex + 1, Math.max(1, tools.length)),
        }),
      );
    }
    if (panelKey(key) === "confirm") {
      const tool = tools[Math.min(state.installed.mcpToolsIndex, tools.length - 1)];
      if (tool) {
        return outcome(
          withInstalled(state, { detail: { kind: "mcp-tool", server: detail.server, tool } }),
        );
      }
    }
  }
  return undefined;
}

export function marketplaceSubKey(
  state: PanelState,
  key: KeyEventData,
  readModel: PanelModelReader,
): KeyOutcome | undefined {
  const { state: current, model } = readModel(state);
  if (panelKey(key) === "back") {
    return outcome(withMarketplaces(current, { view: "list", detailsSelection: 0 }));
  }
  if (current.marketplaces.view === "confirm-remove") {
    const ch = key.sequence;
    if ((ch === "y" || ch === "Y") && model.selectedMarketplace) {
      return outcome(current, { kind: "remove-marketplace", name: model.selectedMarketplace.name });
    }
    if (ch === "n" || ch === "N") {
      return outcome(withMarketplaces(current, { view: "list" }));
    }
    return undefined;
  }
  if (key.name === "up") {
    return outcome(
      withMarketplaces(current, {
        detailsSelection: (current.marketplaces.detailsSelection + 2) % 3,
      }),
    );
  }
  if (key.name === "down") {
    return outcome(
      withMarketplaces(current, {
        detailsSelection: (current.marketplaces.detailsSelection + 1) % 3,
      }),
    );
  }
  if (panelKey(key) === "confirm" && model.selectedMarketplace) {
    if (current.marketplaces.detailsSelection === 0) {
      const filtered = withDiscover(current, {
        marketplaceFilter: model.selectedMarketplace.name,
      });
      return outcome(resetForTab(withNav(filtered, { tab: "discover" })));
    }
    if (current.marketplaces.detailsSelection === 1) {
      // The detail screen keeps the whole refresh — progress and outcome — to itself.
      return outcome(withMarketplaces(current, { detailNotice: null }), {
        kind: "update-marketplace",
        source: model.selectedMarketplace.source,
        inDetail: true,
      });
    }
    return outcome(withMarketplaces(current, { view: "confirm-remove" }));
  }
  return undefined;
}
