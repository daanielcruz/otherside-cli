import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fsModule from "node:fs";
import { resolve } from "node:path";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import {
  applyPersistedEnabledState,
  clear,
  clearEnabledSetting,
  isEnabled,
  isRuntimeEnabled,
  register,
  setEnabled,
} from "@/engine/plugins/registry.ts";
import { getSnapshot, pluginStateStore } from "@/engine/plugins/state.ts";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";

const files = new Map<string, string>();
const dirs = new Set<string>();
const openFiles = new Map<number, { path: string; flags: string }>();
let fdCounter = 1;
let failWrites = false;

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
  if (failWrites) throw new Error("forced settings write failure");
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
fsMock[`copyFile${S}`] = (src: string, dest: string) => {
  const resolvedSrc = resolvePath(src);
  const resolvedDest = resolvePath(dest);
  if (files.has(resolvedSrc)) {
    files.set(resolvedDest, files.get(resolvedSrc)!);
  } else {
    const error = new Error(`ENOENT: no such file or directory, copyfile '${src}' -> '${dest}'`);
    Reflect.set(error, "code", "ENOENT");
    throw error;
  }
};

mock.module("node:fs", () => fsMock);

const mkPlugin = (name: string, source = name): LoadedPlugin => ({
  name,
  path: `/tmp/${name}-${source}`,
  source,
  manifest: { name },
});

function resetPluginState(): void {
  pluginStateStore.replaceLoadedState({ enabled: [], disabled: [], errors: [], warnings: [] });
  pluginStateStore.replaceDesiredState({ enabled: [], disabled: [] });
  pluginStateStore.replaceDiskState({ installations: [] });
  pluginStateStore.markNeedsRefresh(false);
}

describe("registry persistence", () => {
  const dir = "/virtual-config-dir/os-reg-test";
  const prev = process.env.OTHERSIDE_CONFIG_DIR;

  beforeEach(() => {
    process.env.OTHERSIDE_CONFIG_DIR = dir;
    files.clear();
    dirs.clear();
    openFiles.clear();
    fdCounter = 1;
    failWrites = false;
    clear();
    resetPluginState();
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = prev;
    mock.module("node:fs", () => originalFs);
  });

  it("setEnabled returns false for unregistered plugins", async () => {
    expect(await setEnabled("ghost", false)).toBe(false);
  });

  it("setEnabled persists intent before updating desired state and leaves active state unchanged", async () => {
    const plugin = mkPlugin("foo");
    register(plugin);
    await updateConfig((cfg) => {
      cfg.enabledPlugins = { "other@market": true };
    });
    pluginStateStore.replaceLoadedState({
      enabled: [plugin],
      disabled: [],
      errors: [],
      warnings: [],
    });
    const before = getSnapshot();
    let persistedAtStateTransition: Record<string, boolean> | undefined;
    const unsubscribe = pluginStateStore.subscribe(() => {
      persistedAtStateTransition = loadConfigSync().enabledPlugins;
    });

    expect(await setEnabled("foo", false)).toBe(true);
    unsubscribe();

    expect(persistedAtStateTransition).toEqual({
      "other@market": true,
      "foo@foo": false,
    });
    expect(isEnabled("foo")).toBe(false);
    expect(isRuntimeEnabled("foo")).toBe(true);
    const after = getSnapshot();
    expect(after.desired).toEqual({ enabled: ["other@market"], disabled: ["foo@foo"] });
    expect(after.enabled).toEqual(before.enabled);
    expect(after.disabled).toEqual(before.disabled);
    expect(after.needsRefresh).toBe(true);
  });

  it("setEnabled rejects an atomic config-write failure without mutating registry or AppState", async () => {
    const plugin = mkPlugin("foo");
    register(plugin);
    applyPersistedEnabledState({ "foo@foo": false });
    pluginStateStore.replaceDesiredState({ enabled: [], disabled: ["foo@foo"] });
    pluginStateStore.replaceLoadedState({
      enabled: [],
      disabled: [plugin],
      errors: [],
      warnings: [],
    });
    const beforeSnapshot = getSnapshot();
    const beforeConfig = loadConfigSync();
    failWrites = true;

    await expect(setEnabled("foo", true)).rejects.toThrow("forced settings write failure");

    expect(isEnabled("foo")).toBe(false);
    expect(isRuntimeEnabled("foo")).toBe(false);
    expect(getSnapshot()).toBe(beforeSnapshot);
    expect(getSnapshot().needsRefresh).toBe(beforeSnapshot.needsRefresh);
    expect(loadConfigSync()).toEqual(beforeConfig);
  });

  it("canonical persisted keys override legacy bare-name keys regardless of insertion order", () => {
    register(mkPlugin("shared", "alpha"));
    register(mkPlugin("shared", "beta"));

    const diagnostics = applyPersistedEnabledState({
      shared: false,
      "shared@alpha": true,
      "shared@beta": false,
    });

    expect(diagnostics).toEqual([
      {
        code: "PLUGIN_AMBIGUOUS",
        target: "shared",
        candidates: ["shared@alpha", "shared@beta"],
      },
    ]);
    expect(isEnabled("shared@alpha")).toBe(true);
    expect(isRuntimeEnabled("shared@alpha")).toBe(true);
    expect(isEnabled("shared@beta")).toBe(false);
    expect(isRuntimeEnabled("shared@beta")).toBe(false);
  });

  it("applies a unique legacy bare-name key to its sole canonical plugin", () => {
    register(mkPlugin("solo", "official"));

    expect(applyPersistedEnabledState({ solo: false })).toEqual([]);
    expect(isEnabled("solo@official")).toBe(false);
    expect(isRuntimeEnabled("solo@official")).toBe(false);
  });

  it("reports ambiguous legacy names without changing any candidate", () => {
    register(mkPlugin("shared", "zeta"));
    register(mkPlugin("shared", "alpha"));

    expect(applyPersistedEnabledState({ shared: false })).toEqual([
      {
        code: "PLUGIN_AMBIGUOUS",
        target: "shared",
        candidates: ["shared@alpha", "shared@zeta"],
      },
    ]);
    expect(isEnabled("shared@alpha")).toBe(true);
    expect(isEnabled("shared@zeta")).toBe(true);
    expect(isRuntimeEnabled("shared@alpha")).toBe(true);
    expect(isRuntimeEnabled("shared@zeta")).toBe(true);
  });

  it("migrates a matching legacy key when persisting a canonical setting", async () => {
    register(mkPlugin("foo"));
    await updateConfig((cfg) => {
      cfg.enabledPlugins = {
        foo: true,
        "foo@foo": true,
        "other@market": false,
      };
    });

    await setEnabled("foo", false);

    expect(loadConfigSync().enabledPlugins).toEqual({
      "foo@foo": false,
      "other@market": false,
    });
    expect(getSnapshot().desired).toEqual({
      enabled: [],
      disabled: ["foo@foo", "other@market"],
    });
    expect(getSnapshot().needsRefresh).toBe(true);
  });

  it("clears canonical and legacy settings after persistence and keeps runtime state unchanged", async () => {
    const plugin = mkPlugin("foo");
    register(plugin);
    await updateConfig((cfg) => {
      cfg.enabledPlugins = {
        foo: false,
        "foo@foo": false,
        "other@market": true,
      };
    });
    applyPersistedEnabledState(loadConfigSync().enabledPlugins);
    pluginStateStore.replaceLoadedState({
      enabled: [],
      disabled: [plugin],
      errors: [],
      warnings: [],
    });
    const activeBefore = getSnapshot();

    await clearEnabledSetting("foo");

    expect(loadConfigSync().enabledPlugins).toEqual({ "other@market": true });
    expect(isEnabled("foo")).toBe(true);
    expect(isRuntimeEnabled("foo")).toBe(false);
    expect(getSnapshot().desired).toEqual({ enabled: ["other@market"], disabled: [] });
    expect(getSnapshot().enabled).toEqual(activeBefore.enabled);
    expect(getSnapshot().disabled).toEqual(activeBefore.disabled);
    expect(getSnapshot().needsRefresh).toBe(true);
  });

  it("rejects clearEnabledSetting write failure without changing state", async () => {
    const plugin = mkPlugin("foo");
    register(plugin);
    await updateConfig((cfg) => {
      cfg.enabledPlugins = { foo: false, "foo@foo": false };
    });
    applyPersistedEnabledState(loadConfigSync().enabledPlugins);
    pluginStateStore.replaceDesiredState({ enabled: [], disabled: ["foo@foo"] });
    const beforeSnapshot = getSnapshot();
    const beforeConfig = loadConfigSync();
    failWrites = true;

    await expect(clearEnabledSetting("foo")).rejects.toThrow("forced settings write failure");

    expect(isEnabled("foo")).toBe(false);
    expect(isRuntimeEnabled("foo")).toBe(false);
    expect(getSnapshot()).toBe(beforeSnapshot);
    expect(loadConfigSync()).toEqual(beforeConfig);
  });

  it("applyPersistedEnabledState ignores undefined", () => {
    register(mkPlugin("bar"));
    expect(applyPersistedEnabledState(undefined)).toEqual([]);
    expect(isEnabled("bar")).toBe(true);
  });
});
