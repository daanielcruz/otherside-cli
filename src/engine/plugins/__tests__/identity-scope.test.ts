import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  createInstallationId,
  createPluginId,
  isInstallationId,
  normalizeProjectPath,
  parseInstallationId,
} from "@/engine/plugins/identity.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  encodePluginPathSegment,
  listPluginInstallations,
  lookupPluginInstallation,
  PluginMigrationError,
  projectPathFromInstallPath,
  recordPluginInstallation,
} from "@/engine/plugins/installations.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import { loadPluginsFromDirectories } from "@/engine/plugins/loader.ts";
import { clear, lookup, register } from "@/engine/plugins/registry.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

const originalTrackedCwd = getTrackedCwd();
let configDirectory = "";
let projectDirectory = "";

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), "otherside-plugin-config-"));
  projectDirectory = mkdtempSync(join(tmpdir(), "otherside-plugin-project-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDirectory;
});

afterEach(() => {
  setTrackedCwd(originalTrackedCwd);
  delete process.env.OTHERSIDE_CONFIG_DIR;
  rmSync(configDirectory, { recursive: true, force: true });
  rmSync(projectDirectory, { recursive: true, force: true });
});

describe("plugin identity", () => {
  test("normalizes project paths in installation identities", () => {
    const pluginId = createPluginId("formatter", "official");
    const projectPath = normalizeProjectPath(
      join(projectDirectory, "..", basename(projectDirectory)),
    );
    const installationId = createInstallationId(pluginId, "project", projectPath);

    expect(parseInstallationId(installationId)).toEqual({
      name: "formatter",
      marketplace: "official",
      scope: "project",
      projectPath: normalizeProjectPath(projectDirectory)!,
    });
    expect(isInstallationId(installationId)).toBe(true);
  });

  test("rejects an installation identity without a project for project scope", () => {
    expect(() =>
      createInstallationId(createPluginId("formatter", "official"), "project"),
    ).toThrow();
  });

  test("canonicalizes symlinked ancestors before creating installation ids", () => {
    const symlinkPath = join(configDirectory, "project-link");
    symlinkSync(projectDirectory, symlinkPath, "dir");
    const linkedProjectPath = join(symlinkPath, "nested-project");
    const canonicalProjectPath = join(normalizeProjectPath(projectDirectory)!, "nested-project");

    expect(normalizeProjectPath(linkedProjectPath)).toBe(canonicalProjectPath);
    expect(createInstallationId("formatter@official", "local", linkedProjectPath)).toBe(
      createInstallationId("formatter@official", "local", canonicalProjectPath),
    );
  });
});

describe("plugin registry identity", () => {
  test("rejects ambiguous bare names while accepting canonical ids", () => {
    const plugin = (source: string): LoadedPlugin => ({
      name: "duplicate",
      path: join(projectDirectory, source),
      source,
      manifest: { name: "duplicate" },
    });
    clear();
    register(plugin("official"));
    register(plugin("community"));

    expect(lookup("duplicate")).toEqual({
      ok: false,
      code: "PLUGIN_AMBIGUOUS",
      target: "duplicate",
      candidates: ["duplicate@community", "duplicate@official"],
    });
    expect(lookup("duplicate@official").ok).toBe(true);
    clear();
  });
});

describe("plugin installation paths", () => {
  test("keeps versioned cache segments confined and safe", () => {
    const cachePath = cachePathForPlugin("official/../../escape", "formatter/../x", "1/../../2");
    const cacheRoot = join(configDirectory, "plugins", "cache");

    const relativeCachePath = relative(cacheRoot, cachePath);
    expect(relativeCachePath).not.toBe("..");
    expect(relativeCachePath.startsWith(`..${sep}`)).toBe(false);
    expect(relativeCachePath.split(sep)).not.toContain("..");
  });

  test("encodes distinct path values injectively", () => {
    expect(encodePluginPathSegment("a/b")).not.toBe(encodePluginPathSegment("a\\b"));
    expect(encodePluginPathSegment("a/b")).not.toBe(encodePluginPathSegment("a"));
    expect(encodePluginPathSegment("a/b")).toMatch(/^x[0-9a-f]+$/);
  });

  test("migrates a project installation by inferring only its confined project path", () => {
    const installPath = join(projectDirectory, ".otherside", "plugins", "installed", "formatter");
    const cachePath = cachePathForPlugin("official", "formatter", "1.0.0");
    mkdirSync(installPath, { recursive: true });
    mkdirSync(join(configDirectory, "plugins"), { recursive: true });
    writeFileSync(
      join(configDirectory, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "formatter@official": [
            {
              identity: "formatter@official",
              pluginName: "formatter",
              marketplace: "official",
              scope: "project",
              version: "1.0.0",
              installPath,
              cachePath,
              installedAt: "2026-01-01T00:00:00.000Z",
              lastUpdated: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    const [installation] = listPluginInstallations();
    expect(installation?.projectPath).toBe(normalizeProjectPath(projectDirectory));
    expect(installation?.installationId).toBe(
      createInstallationId("formatter@official", "project", projectDirectory),
    );
    expect(
      JSON.parse(readFileSync(join(configDirectory, "plugins", "installed_plugins.json"), "utf8"))
        .version,
    ).toBe(3);
    expect(projectPathFromInstallPath(installPath, "project")).toBe(
      normalizeProjectPath(projectDirectory),
    );
  });

  test("coalesces shared cache relocation across scoped installations", () => {
    const pluginId = createPluginId("formatter", "official");
    const version = "1.0.0";
    const sharedLegacyCache = join(configDirectory, "plugins", "cache", "legacy-formatter");
    const pluginsPath = join(configDirectory, "plugins", "installed_plugins.json");
    const scopes = [
      { scope: "user" as const, projectPath: undefined },
      { scope: "project" as const, projectPath: projectDirectory },
      { scope: "local" as const, projectPath: projectDirectory },
    ];
    const installations = Object.fromEntries(
      scopes.map(({ scope, projectPath }) => [
        scope,
        {
          identity: pluginId,
          pluginName: "formatter",
          marketplace: "official",
          scope,
          ...(projectPath === undefined ? {} : { projectPath }),
          version,
          installPath: activeInstallPath("formatter", scope, "official", version, projectPath),
          cachePath: sharedLegacyCache,
          installedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    mkdirSync(sharedLegacyCache, { recursive: true });
    writeFileSync(join(sharedLegacyCache, "payload.txt"), "shared");
    mkdirSync(dirname(pluginsPath), { recursive: true });
    writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 2,
        plugins: { [pluginId]: Object.values(installations) },
      }),
    );

    const migrated = listPluginInstallations();
    expect(migrated.map((entry) => entry.installationId).sort()).toEqual(
      scopes
        .map(({ scope, projectPath }) => createInstallationId(pluginId, scope, projectPath))
        .sort(),
    );
    expect(existsSync(sharedLegacyCache)).toBe(false);
    const migratedCache = cachePathForPlugin("official", "formatter", version);
    expect(existsSync(migratedCache)).toBe(true);
    expect(readFileSync(join(migratedCache, "payload.txt"), "utf8")).toBe("shared");
    expect(JSON.parse(readFileSync(pluginsPath, "utf8")).version).toBe(3);
  });

  test("rejects different legacy sources for one migration destination", () => {
    const pluginId = createPluginId("formatter", "official");
    const version = "1.0.0";
    const firstLegacyCache = join(configDirectory, "plugins", "cache", "legacy-first");
    const secondLegacyCache = join(configDirectory, "plugins", "cache", "legacy-second");
    const pluginsPath = join(configDirectory, "plugins", "installed_plugins.json");
    const entries = [
      {
        identity: pluginId,
        pluginName: "formatter",
        marketplace: "official",
        scope: "project" as const,
        projectPath: projectDirectory,
        version,
        installPath: activeInstallPath(
          "formatter",
          "project",
          "official",
          version,
          projectDirectory,
        ),
        cachePath: firstLegacyCache,
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:00.000Z",
      },
      {
        identity: pluginId,
        pluginName: "formatter",
        marketplace: "official",
        scope: "local" as const,
        projectPath: projectDirectory,
        version,
        installPath: activeInstallPath("formatter", "local", "official", version, projectDirectory),
        cachePath: secondLegacyCache,
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:00.000Z",
      },
    ];
    mkdirSync(firstLegacyCache, { recursive: true });
    mkdirSync(secondLegacyCache, { recursive: true });
    mkdirSync(dirname(pluginsPath), { recursive: true });
    writeFileSync(pluginsPath, JSON.stringify({ version: 2, plugins: { [pluginId]: entries } }));

    expect(() => listPluginInstallations()).toThrow(PluginMigrationError);
    expect(() => listPluginInstallations()).toThrow(/multiple payloads target/);
  });

  test("uses tracked cwd for canonical, bare, and exact installation lookups", () => {
    const pluginId = createPluginId("formatter", "official");
    const projectA = mkdtempSync(join(tmpdir(), "otherside-plugin-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "otherside-plugin-project-b-"));
    const installations = [
      {
        scope: "user" as const,
        projectPath: undefined,
        version: "1.0.0",
      },
      {
        scope: "project" as const,
        projectPath: projectA,
        version: "2.0.0",
      },
      {
        scope: "project" as const,
        projectPath: projectB,
        version: "3.0.0",
      },
    ];
    try {
      for (const installation of installations) {
        recordPluginInstallation({
          pluginId,
          scope: installation.scope,
          ...(installation.projectPath === undefined
            ? {}
            : { projectPath: installation.projectPath }),
          version: installation.version,
          installPath: activeInstallPath(
            "formatter",
            installation.scope,
            "official",
            installation.version,
            installation.projectPath,
          ),
          cachePath: cachePathForPlugin("official", "formatter", installation.version),
        });
      }
      setTrackedCwd(projectB);

      expect(lookupPluginInstallation(pluginId)).toMatchObject({
        ok: true,
        installation: { scope: "project", projectPath: normalizeProjectPath(projectB) },
      });
      expect(lookupPluginInstallation("formatter")).toMatchObject({
        ok: true,
        pluginId,
        installation: { scope: "project", projectPath: normalizeProjectPath(projectB) },
      });
      const projectBId = createInstallationId(pluginId, "project", projectB);
      expect(lookupPluginInstallation(projectBId)).toMatchObject({
        ok: true,
        installation: { installationId: projectBId },
      });
      const projectAId = createInstallationId(pluginId, "project", projectA);
      expect(lookupPluginInstallation(projectAId)).toEqual({
        ok: false,
        code: "PLUGIN_NOT_FOUND",
        target: projectAId,
        candidates: [],
      });
    } finally {
      rmSync(projectA, { recursive: true, force: true });
      rmSync(projectB, { recursive: true, force: true });
    }
  });

  test("limits bare-name ambiguity to relevant canonical ids", () => {
    const officialId = createPluginId("formatter", "official");
    const communityId = createPluginId("formatter", "community");
    const unrelatedProject = mkdtempSync(join(tmpdir(), "otherside-plugin-unrelated-project-"));
    try {
      recordPluginInstallation({
        pluginId: officialId,
        scope: "user",
        version: "1.0.0",
        installPath: activeInstallPath("formatter", "user", "official", "1.0.0"),
        cachePath: cachePathForPlugin("official", "formatter", "1.0.0"),
      });
      recordPluginInstallation({
        pluginId: officialId,
        scope: "project",
        projectPath: unrelatedProject,
        version: "2.0.0",
        installPath: activeInstallPath(
          "formatter",
          "project",
          "official",
          "2.0.0",
          unrelatedProject,
        ),
        cachePath: cachePathForPlugin("official", "formatter", "2.0.0"),
      });
      setTrackedCwd(projectDirectory);

      expect(lookupPluginInstallation("formatter")).toMatchObject({
        ok: true,
        pluginId: officialId,
      });

      recordPluginInstallation({
        pluginId: communityId,
        scope: "user",
        version: "1.0.0",
        installPath: activeInstallPath("formatter", "user", "community", "1.0.0"),
        cachePath: cachePathForPlugin("community", "formatter", "1.0.0"),
      });
      expect(lookupPluginInstallation("formatter")).toEqual({
        ok: false,
        code: "PLUGIN_AMBIGUOUS",
        target: "formatter",
        candidates: [communityId, officialId],
      });
    } finally {
      rmSync(unrelatedProject, { recursive: true, force: true });
    }
  });

  test("fails closed when a project path cannot be inferred", () => {
    const installPath = join(configDirectory, "plugins", "installed", "formatter");
    mkdirSync(join(configDirectory, "plugins"), { recursive: true });
    writeFileSync(
      join(configDirectory, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "formatter@official": [
            {
              scope: "project",
              version: "1.0.0",
              installPath,
            },
          ],
        },
      }),
    );

    expect(() => listPluginInstallations()).toThrow(PluginMigrationError);
  });

  test("rejects duplicate and conflicting legacy installations", () => {
    const pluginsPath = join(configDirectory, "plugins", "installed_plugins.json");
    mkdirSync(dirname(pluginsPath), { recursive: true });
    const installPath = activeInstallPath("formatter", "user", "official", "1.0.0");
    const cachePath = cachePathForPlugin("official", "formatter", "1.0.0");
    const installation = {
      identity: "formatter@official",
      pluginName: "formatter",
      marketplace: "official",
      scope: "user",
      version: "1.0.0",
      installPath,
      cachePath,
      installedAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 2,
        plugins: { "formatter@official": [installation, { ...installation }] },
      }),
    );
    expect(() => listPluginInstallations()).toThrow(/duplicate installation id/);

    writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "formatter@official": [{ ...installation, marketplace: "community" }],
        },
      }),
    );
    expect(() => listPluginInstallations()).toThrow(/conflicting identity fields/);
  });
});

describe("managed plugin loading", () => {
  test("loads only the current project and applies local, project, user precedence", () => {
    const pluginId = createPluginId("formatter", "official");
    const otherProject = mkdtempSync(join(tmpdir(), "otherside-plugin-other-project-"));
    const unrelatedProject = mkdtempSync(join(tmpdir(), "otherside-plugin-unrelated-project-"));
    try {
      const installations = [
        {
          scope: "user" as const,
          projectPath: undefined,
          version: "1.0.0",
          path: activeInstallPath("formatter", "user", "official", "1.0.0"),
        },
        {
          scope: "project" as const,
          projectPath: projectDirectory,
          version: "2.0.0",
          path: activeInstallPath("formatter", "project", "official", "2.0.0", projectDirectory),
        },
        {
          scope: "local" as const,
          projectPath: projectDirectory,
          version: "3.0.0",
          path: activeInstallPath("formatter", "local", "official", "3.0.0", projectDirectory),
        },
        {
          scope: "project" as const,
          projectPath: otherProject,
          version: "4.0.0",
          path: activeInstallPath("formatter", "project", "official", "4.0.0", otherProject),
        },
      ];
      for (const installation of installations) {
        mkdirSync(installation.path, { recursive: true });
        writeFileSync(
          join(installation.path, "plugin.json"),
          JSON.stringify({ name: "formatter", version: installation.version }),
        );
        recordPluginInstallation({
          pluginId,
          scope: installation.scope,
          ...(installation.projectPath === undefined
            ? {}
            : { projectPath: installation.projectPath }),
          version: installation.version,
          installPath: installation.path,
          cachePath: cachePathForPlugin("official", "formatter", installation.version),
        });
      }

      const current = loadPluginsFromDirectories([join(configDirectory, "plugins", "installed")], {
        cwd: projectDirectory,
      });
      expect(current.errors).toEqual([]);
      expect(current.plugins).toHaveLength(1);
      expect(current.plugins[0]?.manifest.version).toBe("3.0.0");

      const unrelated = loadPluginsFromDirectories(
        [join(configDirectory, "plugins", "installed")],
        { cwd: unrelatedProject },
      );
      expect(unrelated.errors).toEqual([]);
      expect(unrelated.plugins).toHaveLength(1);
      expect(unrelated.plugins[0]?.manifest.version).toBe("1.0.0");
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
      rmSync(unrelatedProject, { recursive: true, force: true });
    }
  });

  test("rejects managed manifests whose name disagrees with the canonical id", () => {
    const pluginId = createPluginId("formatter", "official");
    const installPath = activeInstallPath("formatter", "user", "official", "1.0.0");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(join(installPath, "plugin.json"), JSON.stringify({ name: "renamed" }));
    recordPluginInstallation({
      pluginId,
      scope: "user",
      version: "1.0.0",
      installPath,
      cachePath: cachePathForPlugin("official", "formatter", "1.0.0"),
    });

    const result = loadPluginsFromDirectories([join(configDirectory, "plugins", "installed")], {
      cwd: projectDirectory,
    });
    expect(result.plugins).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        pluginId,
        path: installPath,
        stage: "manifest",
        code: "PLUGIN_IDENTITY_MISMATCH",
        message: expect.stringContaining('expected "formatter"'),
        recoveryHint: expect.stringContaining("reload"),
      }),
    ]);
  });
});
