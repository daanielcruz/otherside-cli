import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  anchoredLegacyPattern,
  directoryPathPattern,
  filePathPattern,
  type PathRuleRoots,
  pathRuleMatches,
} from "@/kernel/permissions/path-rules.ts";
import type { RuleSourceScope } from "@/kernel/permissions/types.ts";

const project = join(process.cwd(), "path-rule-project");
const roots: PathRuleRoots = {
  cwd: project,
  userSettingsRoot: join(process.cwd(), "path-rule-config"),
  flagSettingsRoot: project,
};

function covers(pattern: string, path: string, source: RuleSourceScope = "localSettings"): boolean {
  return pathRuleMatches(pattern, source, path, roots);
}

describe("file rule anchoring", () => {
  test("a pattern without a slash matches that name at any depth under the working directory", () => {
    for (const pattern of [".env", "./.env"]) {
      expect(covers(pattern, join(project, ".env"))).toBe(true);
      expect(covers(pattern, join(project, "apps", "web", ".env"))).toBe(true);
      expect(covers(pattern, join(project, ".env.local"))).toBe(false);
    }
    expect(covers("*.pem", join(project, "certs", "server.pem"))).toBe(true);
    expect(covers(".env", ".env")).toBe(true);
  });

  test("a leading slash starts from the root of the settings the rule came from", () => {
    expect(covers("/src/**", join(project, "src", "a.ts"))).toBe(true);
    expect(covers("/src/**", join(project, "lib", "src", "a.ts"))).toBe(false);
    expect(covers("/hooks/**", join(roots.userSettingsRoot, "hooks", "x.sh"), "userSettings")).toBe(
      true,
    );
    expect(covers("/hooks/**", join(project, "hooks", "x.sh"), "userSettings")).toBe(false);
  });

  test("a double slash starts from the filesystem root, and a tilde from home", () => {
    const outside = join(process.cwd(), "path-rule-outside");
    expect(covers(directoryPathPattern(outside), outside)).toBe(true);
    expect(covers(directoryPathPattern(outside), join(outside, "a", "b.txt"))).toBe(true);
    expect(covers(directoryPathPattern(outside), `${outside}-sibling`)).toBe(false);
    expect(covers("~/.ssh/**", join(homedir(), ".ssh", "id_ed25519"))).toBe(true);
    expect(covers("~/.ssh/**", join(project, ".ssh", "id_ed25519"))).toBe(false);
  });

  test("a pattern never reaches outside the directory it is anchored to", () => {
    expect(covers("*", join(process.cwd(), "elsewhere.txt"))).toBe(false);
    expect(covers("/**", join(project, "any", "file"))).toBe(true);
  });

  test("a saved path keeps glob characters literal", () => {
    const file = join(process.cwd(), "path-rule-outside", "notes[1]*.md");
    expect(covers(filePathPattern(file), file)).toBe(true);
    expect(
      covers(filePathPattern(file), join(process.cwd(), "path-rule-outside", "notes1x.md")),
    ).toBe(false);
  });
});

describe("legacy file rules", () => {
  test("an absolute path saved with one slash is read as the absolute path it meant", () => {
    expect(anchoredLegacyPattern("/tmp/notes/**")).toBe("//tmp/notes/**");
    expect(anchoredLegacyPattern("/src/**")).toBe("/src/**");
    expect(anchoredLegacyPattern("//tmp/notes/**")).toBe("//tmp/notes/**");
    expect(anchoredLegacyPattern(".env")).toBe(".env");
  });
});
