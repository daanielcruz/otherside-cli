import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ephemeralAwareProjectPath,
  isEphemeralCwd,
  isEphemeralSlug,
  pathComponent,
  projectPath,
} from "../paths.ts";

describe("pathComponent", () => {
  it("keeps a name that is already one segment", () => {
    expect(pathComponent("9f8e7d6c-1234-4abc-9def-0123456789ab")).toBe(
      "9f8e7d6c-1234-4abc-9def-0123456789ab",
    );
    expect(pathComponent("a3prddwvq")).toBe("a3prddwvq");
    expect(pathComponent("release.notes_2")).toBe("release.notes_2");
  });

  // What matters is that whatever comes back is one segment: no separator to descend
  // through, and no `..` left standing on its own to climb with.
  it("cannot climb out of the directory it names", () => {
    for (const hostile of ["../../etc/passwd", "..", "nested/child", "/absolute", "a\\b"]) {
      const segment = pathComponent(hostile);
      expect(join("/root", segment).startsWith("/root/")).toBe(true);
      expect(segment).not.toContain("/");
      expect(segment).not.toContain("\\");
    }
  });

  // The directory sweeps skip dotted entries, so a name may not become one.
  it("never produces a hidden or empty segment", () => {
    expect(pathComponent(".highwatermark")).toBe("highwatermark");
    expect(pathComponent("")).toBe("_");
    expect(pathComponent("...")).toBe("_");
    expect(pathComponent("..")).toBe("_");
  });
});

describe("isEphemeralCwd", () => {
  it("persists sessions in user temp cwds", () => {
    expect(isEphemeralCwd("/tmp/work")).toBe(false);
    expect(isEphemeralCwd("/private/tmp/osd")).toBe(false);
    expect(isEphemeralCwd("/var/folders/bf/abc/T/scratch")).toBe(false);
    expect(isEphemeralCwd("/Users/dev/project")).toBe(false);
  });

  it("still flags otherside-internal temp ops by segment", () => {
    expect(isEphemeralCwd("/var/folders/bf/T/otherside-finalize-abc")).toBe(true);
    expect(isEphemeralCwd("/home/u/rev-um-xyz")).toBe(true);
  });
});

describe("isEphemeralSlug", () => {
  it("keeps temp-cwd session slugs (so retention does not purge them)", () => {
    expect(isEphemeralSlug("-tmp-work")).toBe(false);
    expect(isEphemeralSlug("-private-tmp-osd")).toBe(false);
    expect(isEphemeralSlug("-var-folders-bf-T-scratch")).toBe(false);
  });

  it("still flags otherside-internal temp-op slugs", () => {
    expect(isEphemeralSlug("-var-folders-T-otherside-finalize-abc")).toBe(true);
    expect(isEphemeralSlug("-home-u-rev-um-xyz")).toBe(true);
  });
});

describe("ephemeralAwareProjectPath", () => {
  it("returns the persistent projectPath for a normal cwd (byte-identical)", () => {
    const cwd = "/Users/dev/project";
    expect(ephemeralAwareProjectPath(cwd)).toBe(projectPath(cwd));
  });

  it("routes a transient finalize/revert cwd to a tmp tree (no projects/ mint)", () => {
    const cwd = "/var/folders/bf/T/otherside-finalize-abc";
    const result = ephemeralAwareProjectPath(cwd);
    expect(result.startsWith(tmpdir())).toBe(true);
    expect(result).not.toBe(projectPath(cwd));
  });
});
