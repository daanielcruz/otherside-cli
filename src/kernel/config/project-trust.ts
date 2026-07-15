import { resolve } from "node:path";
import { loadConfigSync, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";

function configKeyFor(dir: string): string {
  // Windows path APIs freely flip drive/segment casing; trust keys must be
  // case-insensitive or a trusted root never covers its children and /cd hangs
  // forever waiting for an interactive trust prompt with no UI responder.
  const key = canonicalizeCwd(resolve(dir)).normalize("NFC");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/** Walk ancestors of `dir` looking for a persisted project trust flag. */
export function isPathTrusted(dir: string): boolean {
  const config = loadConfigSync();
  let currentPath = configKeyFor(dir);
  while (true) {
    if (projectTrustAccepted(config.projects, currentPath)) return true;
    const parentPath = configKeyFor(resolve(currentPath, ".."));
    if (parentPath === currentPath) return false;
    currentPath = parentPath;
  }
}

function projectTrustAccepted(projects: UserConfig["projects"] | undefined, key: string): boolean {
  if (!projects) return false;
  if (projects[key]?.trustAccepted === true) return true;
  if (process.platform !== "win32") return false;
  // Read legacy mixed-case keys written before trust keys were lowercased.
  for (const [stored, entry] of Object.entries(projects)) {
    if (stored.toLowerCase() === key && entry?.trustAccepted === true) return true;
  }
  return false;
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
