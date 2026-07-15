import { describe, expect, it } from "bun:test";
import {
  isAcceptEditsBash,
  isSensitiveFilePath,
  isSensitiveWriteApprovable,
} from "@/kernel/permissions/sensitive-paths.ts";

describe("isSensitiveFilePath resolves against the session cwd", () => {
  it("flags a traversal that lands in /etc under a tracked cwd of /", () => {
    expect(isSensitiveFilePath("../../etc/passwd", "/")).toBe(true);
  });

  it("flags an absolute sensitive path regardless of cwd", () => {
    expect(isSensitiveFilePath("/etc/passwd", "/tmp/project")).toBe(true);
  });

  it("does not flag an ordinary file under a non-sensitive cwd", () => {
    expect(isSensitiveFilePath("notes.txt", "/tmp/project")).toBe(false);
  });
});

describe("isSensitiveFilePath protects sensitive configuration paths", () => {
  it("detects upstream dangerous files and nested paths", () => {
    expect(isSensitiveFilePath(".pre-commit-config.yaml", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath(".config/git/config", "/tmp/project")).toBe(true);
  });

  it("matches sensitive basenames and directories case-insensitively", () => {
    expect(isSensitiveFilePath("~/.BASHRC", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath("~/.OtHeRsIdE/settings.json", "/tmp/project")).toBe(true);
  });

  it("retains protection for existing environment and SSH paths", () => {
    expect(isSensitiveFilePath(".env", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath(".ssh/id_ed25519", "/tmp/project")).toBe(true);
  });

  it("flags a sensitive directory when it is the exact final path segment, not just when nested under it", () => {
    expect(isSensitiveFilePath(".git", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath(".git/config", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath(".vscode", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath(".idea", "/tmp/project")).toBe(true);
    expect(isSensitiveFilePath("/tmp/project/.git", "/tmp/project")).toBe(true);
  });

  it("does not flag an ordinary directory that merely shares a prefix with a sensitive segment", () => {
    expect(isSensitiveFilePath("gitignore-notes", "/tmp/project")).toBe(false);
    expect(isSensitiveFilePath("src/build", "/tmp/project")).toBe(false);
  });
});

describe("isSensitiveWriteApprovable checks every representation of the target", () => {
  it("blocks a Write whose lexical path is clean but a resolved representation is sensitive", () => {
    const representations = (path: string) => [path, "/tmp/project/.git/config"];
    expect(
      isSensitiveWriteApprovable(
        "Write",
        { file_path: "/tmp/project/alias/config" },
        "/tmp/project",
        representations,
      ),
    ).toBe(false);
  });

  it("blocks a NotebookEdit whose resolved representation is sensitive", () => {
    const representations = (path: string) => [path, "/tmp/project/.git/config"];
    expect(
      isSensitiveWriteApprovable(
        "NotebookEdit",
        { notebook_path: "/tmp/project/alias/config" },
        "/tmp/project",
        representations,
      ),
    ).toBe(false);
  });

  it("still allows a Write when no representation is sensitive", () => {
    const representations = (path: string) => [path, "/tmp/project/other/config"];
    expect(
      isSensitiveWriteApprovable(
        "Write",
        { file_path: "/tmp/project/alias/config" },
        "/tmp/project",
        representations,
      ),
    ).toBe(true);
  });

  it("defaults to the lexical-only check when no representations resolver is supplied", () => {
    expect(isSensitiveWriteApprovable("Write", { file_path: "/tmp/project/.env" })).toBe(false);
    expect(isSensitiveWriteApprovable("Write", { file_path: "/tmp/project/notes.txt" })).toBe(true);
  });
});

describe("isAcceptEditsBash respects the session cwd for traversal", () => {
  it("refuses `rm ../../etc/passwd` when cwd is /", () => {
    expect(isAcceptEditsBash("rm ../../etc/passwd", "/")).toBe(false);
  });

  it("allows an in-cwd delete that resolves to a non-sensitive path", () => {
    expect(isAcceptEditsBash("rm build/out.txt", "/tmp/project")).toBe(true);
  });

  it("refuses an absolute sensitive target", () => {
    expect(isAcceptEditsBash("rm /etc/hosts", "/tmp/project")).toBe(false);
  });

  it("refuses non-sensitive targets outside the workspace", () => {
    expect(isAcceptEditsBash("rm -rf /Users/example/Documents", "/tmp/project")).toBe(false);
    expect(isAcceptEditsBash("cp ../outside.txt build/out.txt", "/tmp/project")).toBe(false);
  });

  it("refuses path-bearing options that cannot be validated", () => {
    expect(
      isAcceptEditsBash(
        "cp --target-directory=/Users/example/Documents source.txt",
        "/tmp/project",
      ),
    ).toBe(false);
  });

  it("refuses deleting the workspace root itself", () => {
    expect(isAcceptEditsBash("rm -rf .", "/tmp/project")).toBe(false);
  });

  it("refuses `rm -rf .git` / `.vscode` when the sensitive dir is the exact positional arg, matching nested-path handling", () => {
    expect(isAcceptEditsBash("rm -rf .git", "/tmp/project")).toBe(false);
    expect(isAcceptEditsBash("rm -rf .git/config", "/tmp/project")).toBe(false);
    expect(isAcceptEditsBash("rm -rf .vscode", "/tmp/project")).toBe(false);
    expect(isAcceptEditsBash("mv .git backup", "/tmp/project")).toBe(false);
  });

  it("still allows non-sensitive in-cwd deletes and mkdir after the fix", () => {
    expect(isAcceptEditsBash("rm -rf build", "/tmp/project")).toBe(true);
    expect(isAcceptEditsBash("mkdir newdir", "/tmp/project")).toBe(true);
  });
});
