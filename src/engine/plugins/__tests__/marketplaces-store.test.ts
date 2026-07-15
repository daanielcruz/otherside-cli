import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fsModule from "node:fs";
import { resolve } from "node:path";

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
    const parts = resolved.split("/");
    let current = "";
    for (const part of parts) {
      if (part === "" && current === "") {
        current = "/";
        continue;
      }
      current = current === "/" ? `/${part}` : `${current}/${part}`;
      dirs.add(current);
    }
  } else {
    dirs.add(resolved);
  }
  return resolved;
}
function rmFn(p: string, options?: { recursive?: boolean; force?: boolean }): void {
  const resolved = resolvePath(p);
  if (options?.recursive) {
    for (const f of Array.from(files.keys())) {
      if (f === resolved || f.startsWith(resolved + "/")) {
        files.delete(f);
      }
    }
    for (const d of Array.from(dirs)) {
      if (d === resolved || d.startsWith(resolved + "/")) {
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
    const srcPrefix = resolvedSrc + "/";
    const destPrefix = resolvedDest + "/";
    for (const f of Array.from(files.keys())) {
      if (f.startsWith(srcPrefix)) {
        const relative = f.slice(srcPrefix.length);
        files.set(destPrefix + relative, files.get(f)!);
        files.delete(f);
      }
    }
    for (const d of Array.from(dirs)) {
      if (d.startsWith(srcPrefix)) {
        const relative = d.slice(srcPrefix.length);
        dirs.add(destPrefix + relative);
        dirs.delete(d);
      }
    }
  } else {
    const error = new Error(`ENOENT: no such file or directory, rename '${src}' -> '${dest}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
}

const S = "Sync";
const fsMock: Record<string, unknown> = {};
fsMock[`exists${S}`] = existsFn;
fsMock[`mkdir${S}`] = mkdirFn;
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

mock.module("node:fs", () => fsMock);

import { join } from "node:path";
import {
  addKnownMarketplace,
  getKnownMarketplace,
  type KnownMarketplace,
  listAvailableMarketplaces,
  listKnownMarketplaces,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
  removeKnownMarketplace,
} from "@/engine/plugins/marketplaces-store.ts";

const baseEntry = (name: string): KnownMarketplace => ({
  name,
  source: `https://example.com/${name}.git`,
  sourceType: "git",
  installLocation: join(
    process.env.OTHERSIDE_CONFIG_DIR ?? "/tmp",
    "plugins",
    "marketplaces",
    name,
  ),
  lastUpdated: "2026-01-01T00:00:00.000Z",
});

describe("marketplaces-store", () => {
  const dir = `/os-mp-test-${process.pid}-${Date.now()}`;
  const prev = process.env.OTHERSIDE_CONFIG_DIR;

  beforeEach(() => {
    process.env.OTHERSIDE_CONFIG_DIR = dir;
    files.clear();
    dirs.clear();
    openFiles.clear();
    mkdirFn(dir, { recursive: true });
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = prev;
    mock.module("node:fs", () => originalFs);
  });

  it("returns empty when the file is missing", () => {
    expect(listKnownMarketplaces()).toEqual([]);
  });

  it("add/list/get round-trip", () => {
    addKnownMarketplace(baseEntry("alpha"));
    expect(listKnownMarketplaces().map((m) => m.name)).toEqual(["alpha"]);
    expect(getKnownMarketplace("alpha")?.sourceType).toBe("git");
  });

  it("upsert by name replaces the entry", () => {
    addKnownMarketplace(baseEntry("beta"));
    addKnownMarketplace({ ...baseEntry("beta"), source: "https://example.com/new.git" });
    const matches = listKnownMarketplaces().filter((m) => m.name === "beta");
    expect(matches).toHaveLength(1);
    expect(getKnownMarketplace("beta")?.source).toBe("https://example.com/new.git");
  });

  it("keeps the official marketplace fixed when persisted config is tampered", () => {
    addKnownMarketplace({
      ...baseEntry(OFFICIAL_MARKETPLACE_NAME),
      source: "https://example.com/impostor.git",
      sourceType: "git",
      installLocation: "/tmp/impostor",
    });

    const official = getKnownMarketplace(OFFICIAL_MARKETPLACE_NAME);
    expect(official).toMatchObject({
      name: OFFICIAL_MARKETPLACE_NAME,
      source: OFFICIAL_MARKETPLACE_SOURCE,
      sourceType: "github",
      builtIn: true,
    });
    expect(official?.installLocation).toBe(
      join(dir, "plugins", "marketplaces", OFFICIAL_MARKETPLACE_NAME),
    );
    expect(listAvailableMarketplaces()[0]).toEqual(official);
  });

  it("remove returns false for unknown names", () => {
    expect(removeKnownMarketplace("nope")).toBe(false);
  });

  it("remove drops the entry and its managed cache", () => {
    const entry = baseEntry("gamma");
    mkdirFn(entry.installLocation, { recursive: true });
    addKnownMarketplace(entry);

    expect(removeKnownMarketplace("gamma")).toBe(true);
    expect(getKnownMarketplace("gamma")).toBeUndefined();
    expect(existsFn(entry.installLocation)).toBe(false);
  });

  it("remove never deletes an unmanaged path from a tampered registry", () => {
    const entry = { ...baseEntry("tampered"), installLocation: "/user/documents" };
    mkdirFn(entry.installLocation, { recursive: true });
    addKnownMarketplace(entry);

    expect(removeKnownMarketplace("tampered")).toBe(true);
    expect(existsFn(entry.installLocation)).toBe(true);
  });

  it("remove never deletes a file-source marketplace", () => {
    const entry: KnownMarketplace = {
      ...baseEntry("local"),
      source: "/user/marketplace",
      sourceType: "file",
      installLocation: "/user/marketplace",
    };
    mkdirFn(entry.installLocation, { recursive: true });
    addKnownMarketplace(entry);

    expect(removeKnownMarketplace("local")).toBe(true);
    expect(existsFn(entry.installLocation)).toBe(true);
  });
});
