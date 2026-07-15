import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import {
  cachePathForPlugin,
  findPluginInstallation,
  forgetPluginInstallation,
  recordPluginInstallation,
} from "./installations.ts";
import { loadPluginFromDirectory } from "./loader.ts";
import { clearEnabledSetting, register, unregister } from "./registry.ts";

export interface InstallResult {
  success: boolean;
  message: string;
  pluginName?: string;
  identity?: string;
  version?: string;
}

export function getPluginsDir(): string {
  const dir = join(configRoot(), "plugins", "installed");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function installPlugin(source: string): InstallResult {
  const pluginsDir = getPluginsDir();

  // Try to treat as local directory
  let sourceDir = source;
  if (!isAbsolute(sourceDir) && !sourceDir.startsWith("github:") && !sourceDir.startsWith("http")) {
    sourceDir = resolve(process.cwd(), source);
  }

  if (existsSync(sourceDir)) {
    const testLoad = loadPluginFromDirectory(sourceDir, sourceDir);
    if (!testLoad) {
      return { success: false, message: `Invalid plugin directory` };
    }

    const pluginName = testLoad.name;
    const destDir = join(pluginsDir, pluginName);

    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }

    try {
      const version = testLoad.manifest.version || "0.0.0";
      const cachePath = cachePathForPlugin("local", pluginName, version);
      if (!existsSync(cachePath)) {
        mkdirSync(dirname(cachePath), { recursive: true });
        cpSync(sourceDir, cachePath, { recursive: true });
      }
      cpSync(cachePath, destDir, { recursive: true });
      const installation = recordPluginInstallation({
        pluginName,
        marketplace: "local",
        scope: "user",
        version,
        installPath: destDir,
        cachePath,
      });
      const loaded = loadPluginFromDirectory(destDir, "local");
      if (loaded) register(loaded);
      return {
        success: true,
        message: `Installed plugin ${installation.identity} in user scope.`,
        pluginName,
        identity: installation.identity,
        version,
      };
    } catch (e) {
      return {
        success: false,
        message: `Failed to copy plugin: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // Fallback to github clone if it looks like user/repo
  const githubPattern = /^(?:github:)?([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/;
  const match = source.match(githubPattern);
  if (match) {
    const repo = match[1];
    const tempDir = join(pluginsDir, `.tmp-${Date.now()}`);
    try {
      execSync(`git clone https://github.com/${repo}.git "${tempDir}"`, { stdio: "ignore" });

      const testLoad = loadPluginFromDirectory(tempDir, source);
      if (!testLoad) {
        rmSync(tempDir, { recursive: true, force: true });
        return { success: false, message: `Repository is not a valid plugin` };
      }

      const pluginName = testLoad.name;
      const destDir = join(pluginsDir, pluginName);

      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }

      const version = testLoad.manifest.version || "0.0.0";
      const cachePath = cachePathForPlugin("github", pluginName, version);
      mkdirSync(dirname(cachePath), { recursive: true });
      if (!existsSync(cachePath)) cpSync(tempDir, cachePath, { recursive: true });
      cpSync(cachePath, destDir, { recursive: true });
      rmSync(tempDir, { recursive: true, force: true });
      const installation = recordPluginInstallation({
        pluginName,
        marketplace: "github",
        scope: "user",
        version,
        installPath: destDir,
        cachePath,
      });
      const loaded = loadPluginFromDirectory(destDir, "github");
      if (loaded) register(loaded);

      return {
        success: true,
        message: `Installed plugin ${installation.identity} in user scope.`,
        pluginName,
        identity: installation.identity,
        version,
      };
    } catch (e) {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
      return {
        success: false,
        message: `Failed to clone repository: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { success: false, message: `Unrecognized plugin source or path not found: ${source}` };
}

export async function removePlugin(target: string): Promise<InstallResult> {
  const installation = findPluginInstallation(target);
  const pluginName = installation?.pluginName ?? target.split("@")[0] ?? target;
  const destDir = installation?.installPath ?? join(getPluginsDir(), pluginName);
  if (!existsSync(destDir)) {
    return { success: false, message: `Plugin ${target} is not installed.` };
  }

  try {
    await clearEnabledSetting(installation?.identity ?? target);
    rmSync(destDir, { recursive: true, force: true });
    unregister(installation?.identity ?? pluginName);
    if (installation) forgetPluginInstallation(installation.identity);
    return {
      success: true,
      message: `Uninstalled plugin ${installation?.identity ?? pluginName}.`,
      pluginName,
      ...(installation ? { identity: installation.identity, version: installation.version } : {}),
    };
  } catch (e) {
    return {
      success: false,
      message: `Failed to uninstall plugin: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
