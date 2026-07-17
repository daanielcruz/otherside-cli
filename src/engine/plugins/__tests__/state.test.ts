import { describe, expect, test } from "bun:test";
import { createInstallationId } from "../identity.ts";
import type { LoadedPlugin } from "../loader.ts";
import {
  createPluginStateStore,
  type PluginDesiredState,
  type PluginDiskState,
  type PluginStateError,
  type PluginStateWarning,
} from "../state.ts";

function plugin(name: string): LoadedPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    source: "local",
    manifest: { name },
  };
}

const desiredState: PluginDesiredState = {
  enabled: ["alpha@local"],
  disabled: ["beta@local"],
};

const diskState: PluginDiskState = {
  installations: [
    {
      identity: "alpha@local",
      pluginId: "alpha@local",
      installationId: createInstallationId("alpha@local", "user"),
      pluginName: "alpha",
      marketplace: "local",
      scope: "user",
      version: "1.0.0",
      installPath: "/plugins/alpha",
      cachePath: "/cache/alpha",
      installedAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const loadError: PluginStateError = {
  pluginId: "broken@local",
  path: "/plugins/broken",
  stage: "manifest",
  code: "PLUGIN_MANIFEST_INVALID",
  message: "manifest is invalid",
  recoveryHint: "Fix the plugin manifest or remove the installation, then reload plugins.",
};

const loadWarning: PluginStateWarning = {
  path: "/plugins/alpha/plugin.json",
  warning: "deprecated field",
};

describe("plugin state store", () => {
  test("starts with immutable empty state and exposes stable snapshots", () => {
    const store = createPluginStateStore();
    const first = store.getSnapshot();

    expect(first).toEqual({
      enabled: [],
      disabled: [],
      errors: [],
      warnings: [],
      desired: { enabled: [], disabled: [] },
      disk: { installations: [] },
      installationStatus: { marketplaces: [], plugins: [] },
      needsRefresh: false,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.enabled)).toBe(true);
    expect(Object.isFrozen(first.desired)).toBe(true);
    expect(Object.isFrozen(first.disk.installations)).toBe(true);

    store.markNeedsRefresh(false);
    expect(store.getSnapshot()).toBe(first);
  });

  test("notifies only for real transitions and supports unsubscribe", () => {
    const store = createPluginStateStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.markNeedsRefresh();
    store.markNeedsRefresh();
    store.markNeedsRefresh(false);
    expect(notifications).toBe(2);

    unsubscribe();
    store.markNeedsRefresh();
    expect(notifications).toBe(2);
  });

  test("replaces only the active runtime snapshot", () => {
    const store = createPluginStateStore({ desired: desiredState, disk: diskState });

    store.markNeedsRefresh();
    store.replaceLoadedState({
      enabled: [plugin("alpha")],
      disabled: [plugin("beta")],
      errors: [loadError],
      warnings: [loadWarning],
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.enabled.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(snapshot.disabled.map((entry) => entry.name)).toEqual(["beta"]);
    expect(snapshot.errors).toEqual([loadError]);
    expect(snapshot.warnings).toEqual([loadWarning]);
    expect(snapshot.desired).toEqual(desiredState);
    expect(snapshot.disk).toEqual(diskState);
    expect(snapshot.needsRefresh).toBe(false);

    store.beginInstallation({ type: "plugin", id: "gamma@local", name: "gamma" });
    expect(store.getSnapshot().enabled.map((entry) => entry.name)).toEqual(["alpha"]);
  });

  test("keeps installation progress separate from active contributions", () => {
    const store = createPluginStateStore({
      enabled: [plugin("alpha")],
      desired: desiredState,
      disk: diskState,
    });
    const activeBefore = store.getSnapshot().enabled;

    store.beginInstallation({ type: "marketplace", name: "official" });
    expect(store.getSnapshot().installationStatus.marketplaces).toEqual([
      { name: "official", status: "pending" },
    ]);
    expect(store.getSnapshot().enabled).toEqual(activeBefore);

    store.updateInstallation({ type: "marketplace", name: "official", status: "installing" });
    expect(store.getSnapshot().installationStatus.marketplaces).toEqual([
      { name: "official", status: "installing" },
    ]);
    expect(store.getSnapshot().enabled).toEqual(activeBefore);

    store.finishInstallation({ type: "marketplace", name: "official", status: "installed" });
    expect(store.getSnapshot().installationStatus.marketplaces).toEqual([
      { name: "official", status: "installed" },
    ]);
    expect(store.getSnapshot().enabled).toEqual(activeBefore);
    expect(store.getSnapshot().needsRefresh).toBe(true);
    expect(store.getSnapshot().desired).toEqual(desiredState);
    expect(store.getSnapshot().disk).toEqual(diskState);
  });

  test("retains installation failures without requesting an active refresh", () => {
    const store = createPluginStateStore();
    store.beginInstallation({ type: "plugin", id: "broken@local", name: "broken" });
    store.updateInstallation({
      type: "plugin",
      id: "broken@local",
      name: "broken",
      status: "installing",
    });
    store.finishInstallation({
      type: "plugin",
      id: "broken@local",
      name: "broken",
      status: "failed",
      error: "download failed",
    });

    expect(store.getSnapshot().installationStatus.plugins).toEqual([
      { id: "broken@local", name: "broken", status: "failed", error: "download failed" },
    ]);
    expect(store.getSnapshot().needsRefresh).toBe(false);
  });

  test("deduplicates and recovers errors and warnings", () => {
    const store = createPluginStateStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.recordError(loadError);
    store.recordError(loadError);
    store.recordWarning(loadWarning);
    store.recordWarning(loadWarning);
    expect(store.getSnapshot().errors).toEqual([loadError]);
    expect(store.getSnapshot().warnings).toEqual([loadWarning]);
    expect(notifications).toBe(2);

    store.recoverError(loadError);
    store.recoverWarning(loadWarning);
    expect(store.getSnapshot().errors).toEqual([]);
    expect(store.getSnapshot().warnings).toEqual([]);
    expect(notifications).toBe(4);

    store.recoverError(loadError);
    store.recoverWarning(loadWarning);
    expect(notifications).toBe(4);
  });

  test("marks desired and disk changes for a future active reload", () => {
    const store = createPluginStateStore({
      enabled: [plugin("active")],
      disabled: [plugin("inactive")],
    });
    const activeBefore = store.getSnapshot();
    let observedTransition: ReturnType<typeof store.getSnapshot> | undefined;
    store.subscribe(() => {
      observedTransition = store.getSnapshot();
    });

    store.replaceDesiredState(desiredState);

    expect(observedTransition?.desired).toEqual(desiredState);
    expect(observedTransition?.enabled).toEqual(activeBefore.enabled);
    expect(observedTransition?.disabled).toEqual(activeBefore.disabled);
    expect(observedTransition?.needsRefresh).toBe(true);
    expect(store.getSnapshot().desired).toEqual(desiredState);
    expect(store.getSnapshot().enabled).toEqual(activeBefore.enabled);
    expect(store.getSnapshot().needsRefresh).toBe(true);

    store.replaceDiskState(diskState);
    expect(store.getSnapshot().disk).toEqual(diskState);
    expect(store.getSnapshot().enabled).toEqual(activeBefore.enabled);
    expect(store.getSnapshot().needsRefresh).toBe(true);
  });
});
