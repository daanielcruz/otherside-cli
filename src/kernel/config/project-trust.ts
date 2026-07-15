import { resolve } from "node:path";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";

function configKeyFor(dir: string): string {
  return canonicalizeCwd(resolve(dir)).normalize("NFC");
}

/** Walk ancestors of `dir` looking for a persisted project trust flag. */
export function isPathTrusted(dir: string): boolean {
  const config = loadConfigSync();
  let currentPath = configKeyFor(dir);
  while (true) {
    if (config.projects?.[currentPath]?.trustAccepted === true) return true;
    const parentPath = configKeyFor(resolve(currentPath, ".."));
    if (parentPath === currentPath) return false;
    currentPath = parentPath;
  }
}

/** Persist trust for `dir` under user settings projects map. */
export async function setPathTrusted(dir: string): Promise<void> {
  const trustedPath = configKeyFor(dir);
  await updateConfig((cfg) => {
    const existing = cfg.projects?.[trustedPath];
    if (existing?.trustAccepted === true) return;
    cfg.projects = {
      ...cfg.projects,
      [trustedPath]: {
        ...existing,
        trustAccepted: true,
      },
    };
  });
}
