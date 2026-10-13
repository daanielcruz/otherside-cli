import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPluginInstallation } from "@/engine/plugins/installations.ts";
import { loadPluginFromDirectory } from "@/engine/plugins/loader.ts";
import { addMarketplace } from "@/engine/plugins/marketplace.ts";
import {
  installMarketplacePlugin,
  updateMarketplacePlugin,
} from "@/engine/plugins/marketplace-install.ts";
import * as pluginRegistry from "@/engine/plugins/registry.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

let root = "";
let previousConfigRoot: string | undefined;
let previousTrackedCwd = "";

function writePlugin(dir: string, name: string, version: string | undefined, marker: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, description: "fixture", ...(version ? { version } : {}) }),
  );
  writeFileSync(join(dir, "commands", "hello.md"), `${marker}\n`);
}

function writeMarketplace(dir: string, name: string, plugins: string[]): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name,
      owner: { name: "fixture" },
      plugins: plugins.map((plugin) => ({
        name: plugin,
        description: "fixture",
        source: `./plugins/${plugin}`,
      })),
    }),
  );
}

function installedMarker(pluginId: string): string {
  const installation = findPluginInstallation(pluginId);
  if (!installation) return "(not installed)";
  return readFileSync(join(installation.installPath, "commands", "hello.md"), "utf8").trim();
}

/** Registers the installed copy as the one this session has loaded. */
function loadInstalled(pluginId: string): void {
  const installation = findPluginInstallation(pluginId);
  if (!installation) throw new Error(`${pluginId} is not installed`);
  const loaded = loadPluginFromDirectory(installation.installPath, installation.identity, {
    requireManifest: true,
  });
  if (!loaded) throw new Error(`${pluginId} did not load`);
  pluginRegistry.register(loaded);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

beforeEach(() => {
  previousConfigRoot = process.env.OTHERSIDE_CONFIG_DIR;
  previousTrackedCwd = getTrackedCwd();
  root = mkdtempSync(join(tmpdir(), "otherside-plugin-update-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  setTrackedCwd(project);
  pluginRegistry.clear();
});

afterEach(() => {
  pluginRegistry.clear();
  if (previousConfigRoot === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigRoot;
  setTrackedCwd(previousTrackedCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("updateMarketplacePlugin", () => {
  it("installs a newer declared version from a local marketplace", async () => {
    const marketplace = join(root, "local-marketplace");
    writeMarketplace(marketplace, "local-fixture", ["versioned"]);
    writePlugin(join(marketplace, "plugins", "versioned"), "versioned", "1.0.0", "first");
    expect((await addMarketplace(marketplace)).ok).toBe(true);
    expect(installMarketplacePlugin("local-fixture", "versioned").success).toBe(true);

    writePlugin(join(marketplace, "plugins", "versioned"), "versioned", "2.0.0", "second");
    const result = await updateMarketplacePlugin("versioned@local-fixture");

    expect(result.success).toBe(true);
    expect(findPluginInstallation("versioned@local-fixture")?.version).toBe("2.0.0");
    expect(installedMarker("versioned@local-fixture")).toBe("second");
  });

  it("updates a loaded unversioned plugin into a new folder and keeps the loaded copy", async () => {
    const marketplace = join(root, "local-marketplace");
    writeMarketplace(marketplace, "local-fixture", ["unversioned"]);
    writePlugin(join(marketplace, "plugins", "unversioned"), "unversioned", undefined, "first");
    expect((await addMarketplace(marketplace)).ok).toBe(true);
    expect(installMarketplacePlugin("local-fixture", "unversioned").success).toBe(true);
    loadInstalled("unversioned@local-fixture");
    const loadedPath = pluginRegistry.get("unversioned@local-fixture")?.path ?? "";

    writePlugin(join(marketplace, "plugins", "unversioned"), "unversioned", undefined, "second");
    const result = await updateMarketplacePlugin("unversioned@local-fixture");

    expect(result.success).toBe(true);
    const installation = findPluginInstallation("unversioned@local-fixture");
    expect(installation?.installPath).not.toBe(loadedPath);
    expect(installedMarker("unversioned@local-fixture")).toBe("second");
    expect(readFileSync(join(loadedPath, "commands", "hello.md"), "utf8").trim()).toBe("first");
  });

  it("reports an unchanged plugin as already up to date", async () => {
    const marketplace = join(root, "local-marketplace");
    writeMarketplace(marketplace, "local-fixture", ["unversioned"]);
    writePlugin(join(marketplace, "plugins", "unversioned"), "unversioned", undefined, "same");
    expect((await addMarketplace(marketplace)).ok).toBe(true);
    expect(installMarketplacePlugin("local-fixture", "unversioned").success).toBe(true);
    loadInstalled("unversioned@local-fixture");
    const before = findPluginInstallation("unversioned@local-fixture");

    const result = await updateMarketplacePlugin("unversioned@local-fixture");

    expect(result.success).toBe(true);
    expect(result.message).toContain("already up to date");
    expect(result.changed).toBe(false);
    expect(findPluginInstallation("unversioned@local-fixture")?.installPath).toBe(
      before?.installPath ?? "",
    );
  });

  it("re-fetches a git marketplace before reinstalling", async () => {
    const work = join(root, "marketplace-work");
    mkdirSync(work, { recursive: true });
    writeMarketplace(work, "git-fixture", ["remote"]);
    writePlugin(join(work, "plugins", "remote"), "remote", "1.0.0", "first");
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "first");
    const bare = join(root, "marketplace.git");
    git(root, "clone", "-q", "--bare", work, bare);

    expect((await addMarketplace(bare)).ok).toBe(true);
    expect(installMarketplacePlugin("git-fixture", "remote").success).toBe(true);
    expect(installedMarker("remote@git-fixture")).toBe("first");

    writePlugin(join(work, "plugins", "remote"), "remote", "2.0.0", "second");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "second");
    git(work, "push", "-q", bare, "main");

    const result = await updateMarketplacePlugin("remote@git-fixture");

    expect(result.success).toBe(true);
    expect(findPluginInstallation("remote@git-fixture")?.version).toBe("2.0.0");
    expect(installedMarker("remote@git-fixture")).toBe("second");
    expect(existsSync(join(bare, "HEAD"))).toBe(true);
  });
});
