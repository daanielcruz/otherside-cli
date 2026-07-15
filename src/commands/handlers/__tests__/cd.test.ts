import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SlashCommand } from "@/commands/catalog.ts";
import { handleCd, validateCdTarget } from "@/commands/handlers/cd.ts";
import { isImmediateSlash } from "@/commands/immediate.ts";
import type { SlashContext } from "@/commands/types.ts";
import { Session } from "@/engine/session/record/state.ts";
import { checkCdPermission } from "@/kernel/permissions/cd.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";
import { expandPath } from "@/kernel/std/fs/expand-path.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

mock.module("@/kernel/mcp/index.ts", () => ({
  refreshMcpTools: async () => {},
}));
mock.module("@/kernel/channels/ask.ts", () => ({
  askGroup: async () => ({
    declined: false,
    answers: [{ question: "t", answer: "Yes, move here" }],
  }),
}));

const CMD: SlashCommand = {
  name: "cd",
  kind: "instant",
  description: "Change the current working directory",
  argumentHint: "<path>",
};

function makeCtx(session: Session): SlashContext {
  const injections: string[] = [];
  return {
    broker: {
      read: () => ({
        provider: "anthropic",
        model: "x",
        effort: null,
        fastMode: false,
        permissionMode: "default",
        ultracode: false,
      }),
    } as never,
    session,
    agent: {
      pushInjection: (text: string) => {
        injections.push(text);
      },
    } as never,
    exit: () => {},
    clearTranscript: () => {},
    openOverlay: () => {},
    _injections: injections,
  } as SlashContext & { _injections: string[] };
}

describe("expandPath", () => {
  it("expands ~ and ~/", () => {
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("~/Documents")).toBe(join(homedir(), "Documents"));
  });

  it("resolves relative paths against baseDir", () => {
    expect(expandPath("sub", "/tmp/base")).toBe(resolve("/tmp/base", "sub"));
  });

  it("keeps absolute paths", () => {
    expect(expandPath("/usr/bin")).toBe(resolve("/usr/bin"));
  });
});

describe("busy-turn handling", () => {
  it("queues /cd instead of mutating cwd during a turn", () => {
    expect(isImmediateSlash("/cd subdir")).toBe(false);
  });
});

describe("validateCdTarget + handleCd", () => {
  let root: string;
  let priorTracked: string;

  beforeEach(() => {
    root = canonicalizeCwd(mkdtempSync(join(tmpdir(), "otherside-cd-")));
    priorTracked = getTrackedCwd();
    setTrackedCwd(root);
  });

  afterEach(() => {
    setTrackedCwd(priorTracked);
    rmSync(root, { recursive: true, force: true });
  });

  it("requires an argument", async () => {
    const session = new Session("s1", canonicalizeCwd(root));
    const result = await handleCd(CMD, "", makeCtx(session));
    expect(result.feedback).toBe("Usage: /cd <path>");
    expect(session.cwd).toBe(root);
  });

  it("moves to absolute and relative directories", async () => {
    const dest = canonicalizeCwd(join(root, "proj"));
    mkdirSync(dest, { recursive: true });
    const session = new Session("s2", canonicalizeCwd(root));
    setTrackedCwd(session.cwd);
    const abs = await handleCd(CMD, dest, makeCtx(session));
    expect(abs.feedback).toBe(`Moved to ${dest}`);
    expect(session.cwd).toBe(dest);
    expect(getTrackedCwd()).toBe(dest);

    const nested = canonicalizeCwd(join(dest, "nested"));
    mkdirSync(nested, { recursive: true });
    const rel = await handleCd(CMD, "nested", makeCtx(session));
    expect(rel.feedback).toBe(`Moved to ${nested}`);
    expect(session.cwd).toBe(nested);
  });

  it("reports already in for same directory", async () => {
    const session = new Session("s3", canonicalizeCwd(root));
    setTrackedCwd(root);
    const result = await handleCd(CMD, root, makeCtx(session));
    expect(result.feedback).toBe(`Already in ${canonicalizeCwd(root)}.`);
  });

  it("errors for missing and non-directory paths", async () => {
    const session = new Session("s4", canonicalizeCwd(root));
    const missing = await handleCd(CMD, join(root, "nope"), makeCtx(session));
    expect(missing.feedback).toContain("Couldn't find a directory");

    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    const notDir = await handleCd(CMD, file, makeCtx(session));
    expect(notDir.feedback).toContain("is not a directory");
    expect(notDir.feedback).toContain(root);
  });

  it("accepts paths with spaces", async () => {
    const spaced = canonicalizeCwd(join(root, "my project"));
    mkdirSync(spaced, { recursive: true });
    const session = new Session("s5", canonicalizeCwd(root));
    setTrackedCwd(session.cwd);
    const result = await handleCd(CMD, spaced, makeCtx(session));
    expect(result.feedback).toBe(`Moved to ${spaced}`);
    expect(session.cwd).toBe(spaced);
  });

  it("injects a model notice after a successful move", async () => {
    const dest = canonicalizeCwd(join(root, "lib"));
    mkdirSync(dest, { recursive: true });
    const session = new Session("s6", canonicalizeCwd(root));
    setTrackedCwd(session.cwd);
    const ctx = makeCtx(session) as SlashContext & { _injections: string[] };
    await handleCd(CMD, dest, ctx);
    expect(ctx._injections.length).toBe(1);
    expect(ctx._injections[0]).toContain("working directory has changed");
    expect(ctx._injections[0]).toContain(dest);
    expect(ctx._injections[0]).toContain("via /cd");
  });

  it("updates storageCwd so resume identity follows the destination", async () => {
    const dest = canonicalizeCwd(join(root, "storage-move"));
    mkdirSync(dest, { recursive: true });
    const session = new Session("s7", canonicalizeCwd(root));
    setTrackedCwd(session.cwd);
    expect(session.storageCwd).toBe(canonicalizeCwd(root));
    await handleCd(CMD, dest, makeCtx(session));
    expect(session.storageCwd).toBe(dest);
    expect(session.cwd).toBe(dest);
  });

  it("blocks Cd deny rules", async () => {
    const dest = join(root, "blocked");
    mkdirSync(dest);
    const rules: PermissionRule[] = [
      {
        source: "userSettings",
        ruleBehavior: "deny",
        ruleValue: { toolName: "Cd" },
      },
    ];
    const check = checkCdPermission(
      { requestedPath: dest, canonicalPath: dest },
      { rules, baseCwd: root },
    );
    expect(check.result).toBe("blockedByRule");

    const v = await validateCdTarget(dest, root);
    // validate uses live rules from config; still returns ok without a deny in settings.
    // Unit-check the permission helper above is the authoritative deny path.
    expect(v.result === "ok" || v.result === "blocked_by_rule").toBe(true);
  });
});
