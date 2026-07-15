import { beforeEach, describe, expect, it } from "bun:test";
import { basename, dirname, join, resolve } from "node:path";
import { type LoaderFS, loadProjectCommandsFromDirectory } from "@/engine/skills/loader.ts";
import { clear, get } from "@/engine/skills/registry.ts";

describe("loadProjectCommandsFromDirectory", () => {
  const dir = resolve("mock-dir");
  const mockFiles = new Map<string, string>();
  const mockDirs = new Set<string>();

  beforeEach(() => {
    clear();
    mockFiles.clear();
    mockDirs.clear();
    mockDirs.add(dir);
  });

  const mockFs: LoaderFS = {
    readdirSync: (path: string) => {
      if (!mockDirs.has(path)) {
        throw new Error("ENOENT");
      }
      const entries: string[] = [];
      for (const filePath of mockFiles.keys()) {
        if (dirname(filePath) === path) {
          entries.push(basename(filePath));
        }
      }
      return entries;
    },
    statSync: (path: string) => {
      if (mockDirs.has(path)) {
        return { isFile: () => false, isDirectory: () => true };
      }
      if (mockFiles.has(path)) {
        return { isFile: () => true, isDirectory: () => false };
      }
      throw new Error("ENOENT");
    },
    readFileSync: (path: string, encoding: "utf8") => {
      const content = mockFiles.get(path);
      if (content === undefined) {
        throw new Error("ENOENT");
      }
      return content;
    },
  };

  it("registers a project command as user-invocable but NOT model-invocable", () => {
    mockFiles.set(
      join(dir, "deploy.md"),
      "---\ndescription: Deploy the app\nargument-hint: <env>\n---\nDeploy to $ARGUMENTS.",
    );
    const count = loadProjectCommandsFromDirectory(dir, mockFs);
    expect(count).toBe(1);
    const cmd = get("deploy");
    expect(cmd?.userInvocable).toBe(true);
    expect(cmd?.modelInvocable).toBe(false);
    expect(cmd?.body).toContain("Deploy to $ARGUMENTS.");
  });

  it("forces modelInvocable:false even if the file requests modelInvocable:true", () => {
    mockFiles.set(join(dir, "x.md"), "---\nmodelInvocable: true\n---\nbody");
    loadProjectCommandsFromDirectory(dir, mockFs);
    expect(get("x")?.modelInvocable).toBe(false);
  });

  it("returns 0 for a missing directory", () => {
    expect(loadProjectCommandsFromDirectory(join(dir, "nope"), mockFs)).toBe(0);
  });
});
