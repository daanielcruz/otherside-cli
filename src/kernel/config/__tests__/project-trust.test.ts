import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathTrusted, setPathTrusted } from "@/kernel/config/project-trust.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";

describe("project trust keys", () => {
  let root: string;
  let priorConfigDir: string | undefined;

  beforeEach(() => {
    root = canonicalizeCwd(mkdtempSync(join(tmpdir(), "otherside-trust-")));
    priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  });

  afterEach(() => {
    if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("inherits trust for children of a trusted root", async () => {
    await setPathTrusted(root);
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    expect(isPathTrusted(child)).toBe(true);
  });

  it("matches Windows trust keys case-insensitively", async () => {
    if (process.platform !== "win32") return;
    await setPathTrusted(root);
    const flipped = root.replace(/[A-Za-z]/g, (ch) =>
      ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
    );
    expect(isPathTrusted(flipped)).toBe(true);
    const child = join(flipped, "nested");
    mkdirSync(canonicalizeCwd(join(root, "nested")), { recursive: true });
    expect(isPathTrusted(child)).toBe(true);
  });
});
