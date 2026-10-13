import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "@/kernel/permissions/persist.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";

let root: string;
let previousConfigDir: string | undefined;

function permissionsIn(file: string): Record<string, string[]> {
  return JSON.parse(readFileSync(file, "utf8")).permissions;
}

describe("file rules saved before anchoring", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-rule-upgrade-"));
    previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test("are rewritten once to the absolute form they meant, leaving every other rule", async () => {
    const config = join(root, "config");
    const project = join(root, "project");
    mkdirSync(config, { recursive: true });
    mkdirSync(join(project, ".otherside"), { recursive: true });
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read(/tmp/legacy-notes/**)", "Bash(npm *)"],
          deny: ["Read(.env)"],
        },
      }),
    );
    const local = join(project, ".otherside", "settings.local.json");
    writeFileSync(
      local,
      JSON.stringify({ permissions: { allow: ["Edit(/tmp/legacy-edits/*)", "Read(/src/**)"] } }),
    );

    await loadRules(project);

    expect(permissionsIn(join(config, "settings.json"))).toMatchObject({
      allow: ["Read(//tmp/legacy-notes/**)", "Bash(npm *)"],
      deny: ["Read(.env)"],
    });
    expect(permissionsIn(local)).toEqual({
      allow: ["Edit(//tmp/legacy-edits/*)", "Read(/src/**)"],
    });
    const record = JSON.parse(readFileSync(join(config, "permission-path-rules.json"), "utf8"));
    expect(record.files).toContain(
      join(canonicalizeCwd(project), ".otherside", "settings.local.json"),
    );

    writeFileSync(
      local,
      JSON.stringify({ permissions: { allow: ["Read(/tmp/written-later/**)"] } }),
    );
    await loadRules(project);
    expect(permissionsIn(local)).toEqual({ allow: ["Read(/tmp/written-later/**)"] });
  });
});
