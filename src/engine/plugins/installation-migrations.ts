import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import { type PayloadRelocation, PluginMigrationError } from "./installation-records.ts";

function validateMigrationRelocations(
  filePath: string,
  relocations: readonly PayloadRelocation[],
): void {
  const destinations = new Set<string>();
  for (const relocation of relocations) {
    if (destinations.has(relocation.destination)) {
      throw new PluginMigrationError(
        filePath,
        `multiple payloads target ${relocation.destination}`,
      );
    }
    destinations.add(relocation.destination);
    if (existsSync(relocation.destination)) {
      throw new PluginMigrationError(
        filePath,
        `migration destination already exists: ${relocation.destination}`,
      );
    }
  }
}

interface AppliedRelocation {
  readonly relocation: PayloadRelocation;
  readonly stagingPath: string;
  applied: boolean;
}

export function applyRelocations(
  filePath: string,
  relocations: readonly PayloadRelocation[],
): AppliedRelocation[] {
  validateMigrationRelocations(filePath, relocations);
  const applied: AppliedRelocation[] = [];
  try {
    for (const relocation of relocations) {
      mkdirSync(dirname(relocation.destination), { recursive: true });
      const stagingPath = mkdtempSync(join(dirname(relocation.destination), ".plugin-migration-"));
      const appliedRelocation: AppliedRelocation = { relocation, stagingPath, applied: false };
      applied.push(appliedRelocation);
      const stagedPayload = join(stagingPath, "payload");
      cpSync(relocation.source, stagedPayload, { recursive: true });
      renameSync(stagedPayload, relocation.destination);
      appliedRelocation.applied = true;
    }
    return applied;
  } catch (error) {
    rollbackRelocations(applied);
    throw error;
  }
}

export function rollbackRelocations(applied: readonly AppliedRelocation[]): void {
  for (const entry of [...applied].reverse()) {
    if (entry.applied) {
      if (!existsSync(entry.relocation.source) && existsSync(entry.relocation.destination)) {
        mkdirSync(dirname(entry.relocation.source), { recursive: true });
        cpSync(entry.relocation.destination, entry.relocation.source, { recursive: true });
      }
      rmSync(entry.relocation.destination, { recursive: true, force: true });
    }
    rmSync(entry.stagingPath, { recursive: true, force: true });
  }
}

export function finishRelocations(applied: readonly AppliedRelocation[]): void {
  for (const entry of applied) {
    rmSync(entry.relocation.source, { recursive: true, force: true });
    rmSync(entry.stagingPath, { recursive: true, force: true });
  }
}

export function restoreRegistryFile(path: string, raw: string | null): void {
  if (raw === null) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFileSync(path, raw);
}
