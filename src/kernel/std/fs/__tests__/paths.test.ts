import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import {
  ephemeralAwareProjectPath,
  isEphemeralCwd,
  isEphemeralSlug,
  projectPath,
} from "../paths.ts";

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
