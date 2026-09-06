import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fsModule from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

const files = new Map<string, string>();
const dirs = new Set<string>();
const openFiles = new Map<number, { path: string; flags: string }>();
let fdCounter = 1;

const resolvePath = (p: string) => resolve(p);

function existsFn(p: string): boolean {
  const resolved = resolvePath(p);
  return files.has(resolved) || dirs.has(resolved);
}
function mkdirFn(p: string, options?: { recursive?: boolean }): string {
  const resolved = resolvePath(p);
  if (options?.recursive) {
    const parents: string[] = [];
    let current = resolved;
    while (!dirs.has(current)) {
      parents.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const parent of parents.reverse()) dirs.add(parent);
  } else {
    dirs.add(resolved);
  }
  return resolved;
}
let tempCounter = 0;
function mkdtempFn(prefix: string): string {
  tempCounter += 1;
  const path = `${prefix}${tempCounter}`;
  mkdirFn(path, { recursive: true });
  return path;
}

function rmFn(p: string, options?: { recursive?: boolean; force?: boolean }): void {
  const resolved = resolvePath(p);
  if (options?.recursive) {
    for (const f of Array.from(files.keys())) {
      if (f === resolved || f.startsWith(resolved + sep)) {
        files.delete(f);
      }
    }
    for (const d of Array.from(dirs)) {
      if (d === resolved || d.startsWith(resolved + sep)) {
        dirs.delete(d);
      }
    }
  } else {
    if (!files.delete(resolved) && !dirs.delete(resolved) && !options?.force) {
      const error = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      Reflect.set(error, "code", "ENOENT");
      throw error;
    }
  }
}
function writeFileFn(p: string, content: string | Uint8Array): void {
  const resolved = resolvePath(p);
  files.set(resolved, typeof content === "string" ? content : new TextDecoder().decode(content));
}
function readFileFn(p: string, encoding?: string): string | Uint8Array {
  const resolved = resolvePath(p);
  if (!files.has(resolved)) {
    const error = new Error(`ENOENT: no such file or directory, open '${p}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
  const content = files.get(resolved)!;
  if (encoding === "utf8" || encoding === "utf-8" || encoding) {
    return content;
  }
  return new TextEncoder().encode(content);
}
function statFn(p: string) {
  const resolved = resolvePath(p);
  if (files.has(resolved)) {
    return {
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: Date.now(),
    };
  }
  if (dirs.has(resolved)) {
    return {
      isFile: () => false,
      isDirectory: () => true,
      mtimeMs: Date.now(),
    };
  }
  const error = new Error(`ENOENT: no such file or directory, stat '${p}'`);
  Reflect.set(error, "code", "ENOENT");
  throw error;
}
function renameFn(src: string, dest: string): void {
  const resolvedSrc = resolvePath(src);
  const resolvedDest = resolvePath(dest);
  if (files.has(resolvedSrc)) {
    files.set(resolvedDest, files.get(resolvedSrc)!);
    files.delete(resolvedSrc);
  } else if (dirs.has(resolvedSrc)) {
    dirs.add(resolvedDest);
    dirs.delete(resolvedSrc);
    const srcPrefix = resolvedSrc + sep;
    for (const f of Array.from(files.keys())) {
      if (f.startsWith(srcPrefix)) {
        files.set(join(resolvedDest, relative(resolvedSrc, f)), files.get(f)!);
        files.delete(f);
      }
    }
    for (const d of Array.from(dirs)) {
      if (d.startsWith(srcPrefix)) {
        dirs.add(join(resolvedDest, relative(resolvedSrc, d)));
        dirs.delete(d);
      }
    }
  } else {
    const error = new Error(`ENOENT: no such file or directory, rename '${src}' -> '${dest}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
}
function cpFn(src: string, dest: string, _options?: { recursive?: boolean }): void {
  const resolvedSrc = resolvePath(src);
  const resolvedDest = resolvePath(dest);
  if (files.has(resolvedSrc)) {
    files.set(resolvedDest, files.get(resolvedSrc)!);
  } else if (dirs.has(resolvedSrc)) {
    dirs.add(resolvedDest);
    const srcPrefix = resolvedSrc + sep;
    for (const f of Array.from(files.keys())) {
      if (f.startsWith(srcPrefix)) {
        files.set(join(resolvedDest, relative(resolvedSrc, f)), files.get(f)!);
      }
    }
    for (const d of Array.from(dirs)) {
      if (d.startsWith(srcPrefix)) {
        dirs.add(join(resolvedDest, relative(resolvedSrc, d)));
      }
    }
  } else {
    const error = new Error(`ENOENT: no such file or directory, cp '${src}' -> '${dest}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
}

const S = "Sync";
const fsMock: Record<string, unknown> = {};
fsMock[`exists${S}`] = existsFn;
fsMock[`mkdir${S}`] = mkdirFn;
fsMock[`mkdtemp${S}`] = mkdtempFn;
fsMock[`rm${S}`] = rmFn;
fsMock[`writeFile${S}`] = writeFileFn;
fsMock[`readFile${S}`] = readFileFn;
fsMock[`stat${S}`] = statFn;
fsMock[`rename${S}`] = renameFn;
fsMock[`unlink${S}`] = (p: string) => {
  const resolved = resolvePath(p);
  if (!files.delete(resolved)) {
    const error = new Error(`ENOENT: no such file or directory, unlink '${p}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
};
fsMock[`chmod${S}`] = (_p: string, _mode: number) => {};
fsMock[`open${S}`] = (p: string, flags: string, _mode?: number) => {
  const resolved = resolvePath(p);
  if (flags.includes("x")) {
    if (files.has(resolved) || dirs.has(resolved)) {
      const error = new Error(`EEXIST: file already exists, open '${p}'`);
      Reflect.set(error, "code", "EEXIST");
      throw error;
    }
  }
  if (!files.has(resolved)) {
    files.set(resolved, "");
  }
  const fd = fdCounter++;
  openFiles.set(fd, { path: resolved, flags });
  return fd;
};
fsMock[`write${S}`] = (fd: number, content: string | Uint8Array) => {
  const openFile = openFiles.get(fd);
  if (!openFile) {
    throw new Error("EBADF: bad file descriptor");
  }
  const str = typeof content === "string" ? content : new TextDecoder().decode(content);
  files.set(openFile.path, str);
};
fsMock[`close${S}`] = (fd: number) => {
  if (!openFiles.has(fd)) {
    throw new Error("EBADF: bad file descriptor");
  }
  openFiles.delete(fd);
};
fsMock[`cp${S}`] = cpFn;

mock.module("node:fs", () => fsMock);

import { activeInstallPath, listPluginInstallations } from "@/engine/plugins/installations.ts";
import {
  addMarketplace,
  getCachedManifest,
  listMarketplacePlugins,
} from "@/engine/plugins/marketplace.ts";
import { installMarketplacePlugin } from "@/engine/plugins/marketplace-install.ts";
import {
  detectSourceType,
  parseMarketplaceManifest,
} from "@/engine/plugins/marketplace-manifest.ts";
import { getKnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";

describe("marketplace parse + detect", () => {
  it("parseMarketplaceManifest parses a valid manifest", () => {
    const manifest = parseMarketplaceManifest({
      name: "my-mp",
      owner: { name: "tester" },
      plugins: [
        { name: "alpha", description: "a plugin", source: "./alpha" },
        { name: "beta", source: { source: "github", repo: "u/beta" } },
      ],
    });
    expect(manifest?.name).toBe("my-mp");
    expect(manifest?.plugins).toHaveLength(2);
    expect(manifest?.plugins[0]?.description).toBe("a plugin");
    expect(manifest?.plugins[1]?.source).toEqual({ source: "github", repo: "u/beta" });
  });

  it("parseMarketplaceManifest rejects invalid input", () => {
    expect(parseMarketplaceManifest(null)).toBeNull();
    expect(parseMarketplaceManifest({ plugins: [] })).toBeNull();
    expect(parseMarketplaceManifest({ name: "x" })).toBeNull();
  });

  it("parseMarketplaceManifest skips unsafe names and malformed sources", () => {
    const manifest = parseMarketplaceManifest({
      name: "mp",
      plugins: [
        { description: "no name" },
        { name: "../escape", source: "./bad" },
        { name: "broken", source: { source: "url" } },
        { name: "ok", source: "./ok" },
      ],
    });
    expect(manifest?.plugins.map((p) => p.name)).toEqual(["ok"]);
    expect(parseMarketplaceManifest({ name: "../escape", plugins: [] })).toBeNull();
  });

  it("parseMarketplaceManifest accepts url and git-subdir sources", () => {
    const manifest = parseMarketplaceManifest({
      name: "mp",
      plugins: [
        { name: "remote", source: { source: "url", url: "https://example.com/repo" } },
        {
          name: "nested",
          source: { source: "git-subdir", url: "owner/repo", path: "plugins/nested" },
        },
      ],
    });
    expect(manifest?.plugins.map((plugin) => plugin.source)).toEqual([
      { source: "url", url: "https://example.com/repo" },
      { source: "git-subdir", url: "owner/repo", path: "plugins/nested" },
    ]);
  });

  it("detectSourceType classifies sources", () => {
    expect(detectSourceType("owner/repo")).toBe("github");
    expect(detectSourceType("https://example.com/x.git")).toBe("git");
    expect(detectSourceType("git@github.com:o/r.git")).toBe("git");
    expect(detectSourceType("/abs/path")).toBe("file");
    expect(detectSourceType("./relative")).toBe("file");
  });
});

describe("marketplace file-source end-to-end", () => {
  const configDir = `/os-mp-e2e-${process.pid}-${Date.now()}`;
  const mpDir = join(configDir, "local-marketplace");
  const prev = process.env.OTHERSIDE_CONFIG_DIR;
  const mpName = "local-marketplace";
  const pluginName = "alpha";

  beforeEach(() => {
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    rmFn(configDir, { recursive: true, force: true });
    mkdirFn(configDir, { recursive: true });
    mkdirFn(join(mpDir, ".claude-plugin"), { recursive: true });
    mkdirFn(join(mpDir, pluginName), { recursive: true });
    writeFileFn(
      join(mpDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: mpName,
        owner: { name: "tester" },
        plugins: [{ name: pluginName, description: "alpha plugin", source: `./${pluginName}` }],
      }),
    );
    writeFileFn(
      join(mpDir, pluginName, "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0" }),
    );
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = prev;
    mock.module("node:fs", () => originalFs);
  });

  it("addMarketplace parses a file marketplace and persists it", async () => {
    const res = await addMarketplace(mpDir);
    expect(res.ok).toBe(true);
    expect(res.name).toBe(mpName);
    expect(res.count).toBe(1);
    expect(getKnownMarketplace(mpName)?.sourceType).toBe("file");
  });

  it("listMarketplacePlugins returns entries from the cached manifest", async () => {
    await addMarketplace(mpDir);
    const plugins = listMarketplacePlugins(mpName);
    expect(plugins.map((p) => p.name)).toEqual([pluginName]);
  });

  it("installMarketplacePlugin copies the plugin into plugins/installed", async () => {
    await addMarketplace(mpDir);
    const res = installMarketplacePlugin(mpName, pluginName);
    expect(res.success).toBe(true);
    expect(res.pluginName).toBe(pluginName);
    expect(
      existsFn(join(activeInstallPath(pluginName, "user", mpName, "1.0.0"), "plugin.json")),
    ).toBe(true);
  });

  it("installs a non-strict manifestless plugin with generated metadata", async () => {
    rmFn(join(mpDir, pluginName, "plugin.json"), { force: true });
    writeFileFn(
      join(mpDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: mpName,
        owner: { name: "tester" },
        plugins: [{ name: pluginName, source: `./${pluginName}`, strict: false }],
      }),
    );
    await addMarketplace(mpDir);

    const res = installMarketplacePlugin(mpName, pluginName);

    expect(res.success).toBe(true);
    expect(
      existsFn(
        join(
          activeInstallPath(pluginName, "user", mpName, "0.0.0"),
          ".claude-plugin",
          "plugin.json",
        ),
      ),
    ).toBe(true);
  });

  it("rejects another install when the plugin is already installed", async () => {
    await addMarketplace(mpDir);
    expect(installMarketplacePlugin(mpName, pluginName, "user").success).toBe(true);

    const duplicate = installMarketplacePlugin(mpName, pluginName, "project");

    expect(duplicate).toMatchObject({
      success: false,
      message: `Plugin '${pluginName}@${mpName}' is already installed. Use '/plugins' to manage existing plugins.`,
    });
    const installations = listPluginInstallations().filter(
      (installation) => installation.identity === `${pluginName}@${mpName}`,
    );
    expect(installations.map((installation) => installation.scope)).toEqual(["user"]);
  });

  it("preserves an existing install when replacement validation fails", async () => {
    await addMarketplace(mpDir);
    expect(installMarketplacePlugin(mpName, pluginName).success).toBe(true);
    const installedManifest = join(
      activeInstallPath(pluginName, "user", mpName, "1.0.0"),
      "plugin.json",
    );
    expect(existsFn(installedManifest)).toBe(true);

    writeFileFn(join(mpDir, pluginName, "plugin.json"), "{ invalid json");
    const result = installMarketplacePlugin(mpName, pluginName);

    expect(result.success).toBe(false);
    expect(existsFn(installedManifest)).toBe(true);
  });

  it("rejects local plugin sources that escape the marketplace", async () => {
    mkdirFn(join(configDir, "outside"), { recursive: true });
    writeFileFn(join(configDir, "outside", "plugin.json"), JSON.stringify({ name: pluginName }));
    writeFileFn(
      join(mpDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: mpName,
        owner: { name: "tester" },
        plugins: [{ name: pluginName, source: "../outside" }],
      }),
    );
    await addMarketplace(mpDir);

    const res = installMarketplacePlugin(mpName, pluginName);

    expect(res.success).toBe(false);
    expect(res.message).toContain("escapes marketplace");
  });

  it("getCachedManifest returns the parsed manifest", async () => {
    await addMarketplace(mpDir);
    expect(getCachedManifest(mpName)?.name).toBe(mpName);
  });

  it("installMarketplacePlugin fails for unknown plugins", async () => {
    await addMarketplace(mpDir);
    const res = installMarketplacePlugin(mpName, "no-such-plugin");
    expect(res.success).toBe(false);
  });
});
