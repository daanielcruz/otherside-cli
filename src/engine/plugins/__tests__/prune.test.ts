import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentRegistry from "@/engine/agents/registry.ts";
import { installPlugin, removePlugin } from "@/engine/plugins/install.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  installedPluginsPath,
  listPluginInstallations,
  pluginCacheRoot,
  recordPluginInstallation,
  removePluginInstallationById,
} from "@/engine/plugins/installations.ts";
import {
  markRemovedInstallationPayloads,
  ORPHANED_MARKER_FILENAME,
  ORPHANED_PAYLOAD_RETENTION_MS,
  sweepOrphanedPluginPayloads,
} from "@/engine/plugins/prune.ts";
import * as pluginRegistry from "@/engine/plugins/registry.ts";
import { pluginStateStore } from "@/engine/plugins/state.ts";
import * as skillRegistry from "@/engine/skills/registry.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

const PLUGIN_ID = "demo@local";
const EXPIRED = ORPHANED_PAYLOAD_RETENTION_MS + 60_000;

let root = "";
let project = "";
let previousConfigRoot: string | undefined;
let previousTrackedCwd = "";

function writePluginSource(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "demo", version }));
  writeFileSync(join(dir, "README.md"), `demo ${version}`);
  return dir;
}

function marker(payloadDir: string): string {
  return join(payloadDir, ORPHANED_MARKER_FILENAME);
}

function writeExpiredMarker(payloadDir: string): void {
  const stampedAt = Date.now() - EXPIRED;
  writeFileSync(marker(payloadDir), `${stampedAt}`);
  utimesSync(marker(payloadDir), stampedAt / 1000, stampedAt / 1000);
}

beforeEach(() => {
  previousConfigRoot = process.env.OTHERSIDE_CONFIG_DIR;
  previousTrackedCwd = getTrackedCwd();
  root = mkdtempSync(join(tmpdir(), "otherside-plugin-prune-"));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  mkdirSync(configRoot(), { recursive: true });
  writeFileSync(join(configRoot(), "settings.json"), JSON.stringify({}));
  setTrackedCwd(project);
  pluginRegistry.clear();
  agentRegistry.clear();
  skillRegistry.clear();
  pluginStateStore.replaceSnapshot({
    enabled: [],
    disabled: [],
    errors: [],
    warnings: [],
    desired: { enabled: [], disabled: [] },
    disk: { installations: [] },
    installationStatus: { marketplaces: [], plugins: [] },
    needsRefresh: false,
  });
});

afterEach(() => {
  pluginRegistry.clear();
  agentRegistry.clear();
  skillRegistry.clear();
  if (previousConfigRoot === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigRoot;
  setTrackedCwd(previousTrackedCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("uninstall payload marking", () => {
  it("one-scope uninstall marks only that payload; the shared cache and the other scope survive", async () => {
    const source = writePluginSource(join(root, "source"), "1.0.0");
    expect(installPlugin(source, { scope: "user" }).success).toBe(true);
    pluginRegistry.clear();
    expect(installPlugin(source, { scope: "project" }).success).toBe(true);

    const userPayload = activeInstallPath("demo", "user", "local", "1.0.0");
    const projectPayload = activeInstallPath("demo", "project", "local", "1.0.0", project);
    const cachePayload = cachePathForPlugin("local", "demo", "1.0.0");

    // Lookup rank prefers the project scope, so the first uninstall removes it.
    pluginRegistry.clear();
    const removed = await removePlugin(PLUGIN_ID);
    expect(removed.success).toBe(true);
    expect(listPluginInstallations().map((entry) => entry.scope)).toEqual(["user"]);

    expect(existsSync(projectPayload)).toBe(true);
    expect(existsSync(marker(projectPayload))).toBe(true);
    expect(existsSync(marker(userPayload))).toBe(false);
    expect(existsSync(marker(cachePayload))).toBe(false);
  });

  it("final-scope uninstall marks the shared cache as well", async () => {
    const source = writePluginSource(join(root, "source"), "1.0.0");
    expect(installPlugin(source, { scope: "user" }).success).toBe(true);

    const userPayload = activeInstallPath("demo", "user", "local", "1.0.0");
    const cachePayload = cachePathForPlugin("local", "demo", "1.0.0");

    pluginRegistry.clear();
    const removed = await removePlugin(PLUGIN_ID);
    expect(removed.success).toBe(true);
    expect(listPluginInstallations()).toEqual([]);
    expect(existsSync(marker(userPayload))).toBe(true);
    expect(existsSync(marker(cachePayload))).toBe(true);
  });

  it("reinstall clears the orphan stamp from cache and payload", async () => {
    const source = writePluginSource(join(root, "source"), "1.0.0");
    expect(installPlugin(source, { scope: "user" }).success).toBe(true);
    pluginRegistry.clear();
    expect((await removePlugin(PLUGIN_ID)).success).toBe(true);

    const userPayload = activeInstallPath("demo", "user", "local", "1.0.0");
    const cachePayload = cachePathForPlugin("local", "demo", "1.0.0");
    expect(existsSync(marker(cachePayload))).toBe(true);

    pluginRegistry.clear();
    expect(installPlugin(source, { scope: "user" }).success).toBe(true);
    expect(existsSync(marker(userPayload))).toBe(false);
    expect(existsSync(marker(cachePayload))).toBe(false);
  });
});

describe("orphaned payload sweep", () => {
  it("stamps unreferenced payloads, keeps fresh ones, and deletes expired ones with their empty parents", () => {
    const unmarked = join(pluginCacheRoot(), "xaa", "xbb", "xcc");
    mkdirSync(unmarked, { recursive: true });
    const fresh = join(pluginCacheRoot(), "xaa", "xbb", "xdd");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(marker(fresh), `${Date.now()}`);
    const expired = join(pluginCacheRoot(), "xee", "xff", "xgg");
    mkdirSync(expired, { recursive: true });
    writeExpiredMarker(expired);

    sweepOrphanedPluginPayloads({ cwd: project });

    expect(existsSync(unmarked)).toBe(true);
    expect(existsSync(marker(unmarked))).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(join(pluginCacheRoot(), "xee"))).toBe(false);
    expect(existsSync(pluginCacheRoot())).toBe(true);
  });

  it("unmarks payloads that are referenced by an installation record again", () => {
    const installPath = activeInstallPath("demo", "user", "local", "1.0.0");
    const cachePath = cachePathForPlugin("local", "demo", "1.0.0");
    mkdirSync(installPath, { recursive: true });
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(marker(installPath), `${Date.now() - EXPIRED}`);
    writeFileSync(marker(cachePath), `${Date.now() - EXPIRED}`);
    recordPluginInstallation({
      pluginId: PLUGIN_ID,
      scope: "user",
      version: "1.0.0",
      installPath,
      cachePath,
    });

    sweepOrphanedPluginPayloads({ cwd: project });

    expect(existsSync(installPath)).toBe(true);
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(marker(installPath))).toBe(false);
    expect(existsSync(marker(cachePath))).toBe(false);
  });

  it("sweeps the project-scope install roots of the current project", () => {
    const projectPayload = join(
      project,
      ".otherside",
      "plugins",
      "installed",
      "xscope",
      "xmp",
      "xname",
      "xver",
    );
    mkdirSync(projectPayload, { recursive: true });
    writeExpiredMarker(projectPayload);

    sweepOrphanedPluginPayloads({ cwd: project });

    expect(existsSync(projectPayload)).toBe(false);
    expect(existsSync(join(project, ".otherside", "plugins", "installed", "xscope"))).toBe(false);
  });

  it("aborts without deleting anything when the installation registry is unreadable", () => {
    const expired = join(pluginCacheRoot(), "xee", "xff", "xgg");
    mkdirSync(expired, { recursive: true });
    writeExpiredMarker(expired);
    mkdirSync(join(configRoot(), "plugins"), { recursive: true });
    writeFileSync(installedPluginsPath(), "{ not json");

    sweepOrphanedPluginPayloads({ cwd: project });

    expect(existsSync(expired)).toBe(true);
  });
});

describe("mark helper refcounting", () => {
  it("never stamps a payload path that another installation still uses", () => {
    const cachePath = cachePathForPlugin("local", "demo", "1.0.0");
    const userPath = activeInstallPath("demo", "user", "local", "1.0.0");
    const projectPath = activeInstallPath("demo", "project", "local", "1.0.0", project);
    mkdirSync(cachePath, { recursive: true });
    mkdirSync(userPath, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    const kept = recordPluginInstallation({
      pluginId: PLUGIN_ID,
      scope: "user",
      version: "1.0.0",
      installPath: userPath,
      cachePath,
    });
    const removed = recordPluginInstallation({
      pluginId: PLUGIN_ID,
      scope: "project",
      projectPath: project,
      version: "1.0.0",
      installPath: projectPath,
      cachePath,
    });
    expect(kept.installationId).not.toBe(removed.installationId);

    // Simulate the record removal that precedes marking.
    removePluginInstallationById(removed.installationId);
    markRemovedInstallationPayloads(removed);

    expect(existsSync(marker(projectPath))).toBe(true);
    expect(existsSync(marker(userPath))).toBe(false);
    expect(existsSync(marker(cachePath))).toBe(false);
  });
});
