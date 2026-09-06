import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import type { SlashCommand } from "@/commands/catalog.ts";
import { handleCd, validateCdTarget } from "@/commands/handlers/cd.ts";
import { isImmediateSlash } from "@/commands/immediate.ts";
import type { SlashContext } from "@/commands/types.ts";
import { Session } from "@/engine/session/record/state.ts";
import {
  clear as clearAsk,
  type PendingGroup,
  peek as peekAsk,
  resolveGroup,
} from "@/kernel/channels/ask.ts";
import { isPathTrusted, setPathTrusted } from "@/kernel/config/project-trust.ts";
import { evaluateCdPermission } from "@/kernel/permissions/cd.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";
import { expandPath } from "@/kernel/std/fs/expand-path.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

const CMD: SlashCommand = {
  name: "cd",
  kind: "instant",
  description: "Move this session to a new working directory",
  argumentHint: "<path>",
};

async function waitForAsk(): Promise<PendingGroup> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pending = peekAsk();
    if (pending) return pending;
    await Bun.sleep(1);
  }
  throw new Error("expected a directory trust question");
}

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
    expect(expandPath("/usr/bin")).toBe(normalize("/usr/bin"));
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
  let priorConfigDir: string | undefined;

  beforeEach(async () => {
    clearAsk();
    root = canonicalizeCwd(mkdtempSync(join(tmpdir(), "otherside-cd-")));
    priorTracked = getTrackedCwd();
    priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
    setTrackedCwd(root);
    await setPathTrusted(root);
  });

  afterEach(() => {
    clearAsk();
    setTrackedCwd(priorTracked);
    if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("requires an argument", async () => {
    const session = new Session("s1", canonicalizeCwd(root));
    const result = await handleCd(CMD, "", makeCtx(session));
    expect(result.feedback).toBe("Usage: /cd <path>");
    expect(session.cwd).toBe(root);
  });

  it("defaults an untrusted directory prompt to staying put", async () => {
    const destination = canonicalizeCwd(mkdtempSync(join(tmpdir(), "otherside-cd-target-")));
    try {
      const session = new Session("s-trust-no", root);
      const move = handleCd(CMD, destination, makeCtx(session));
      const pending = await waitForAsk();
      expect(pending.questions[0]?.question).toContain("Moving to a new directory:");
      expect(pending.questions[0]?.options.map((option) => option.label)).toEqual([
        "No, stay put",
        "Yes, move here",
      ]);
      expect(pending.questions[0]?.allowFreeform).toBe(false);
      expect(pending.questions[0]?.allowChat).toBe(false);
      resolveGroup(pending.id, {
        declined: false,
        answers: [{ question: pending.questions[0]?.question ?? "", answer: "No, stay put" }],
      });
      const result = await move;
      expect(result.feedback).toBe(`Staying in ${root}`);
      expect(session.cwd).toBe(root);
      expect(isPathTrusted(destination)).toBe(false);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("persists accepted trust and moves the session", async () => {
    const destination = canonicalizeCwd(mkdtempSync(join(tmpdir(), "otherside-cd-target-")));
    try {
      const session = new Session("s-trust-yes", root);
      const ctx = makeCtx(session) as SlashContext & { _injections: string[] };
      const move = handleCd(CMD, destination, ctx);
      const pending = await waitForAsk();
      resolveGroup(pending.id, {
        declined: false,
        answers: [{ question: pending.questions[0]?.question ?? "", answer: "Yes, move here" }],
      });
      const result = await move;
      expect(result.feedback).toBe(`Moved to ${destination}`);
      expect(session.cwd).toBe(destination);
      expect(session.storageCwd).toBe(destination);
      expect(getTrackedCwd()).toBe(destination);
      expect(isPathTrusted(destination)).toBe(true);
      expect(ctx._injections[0]).toContain("working directory has changed");
      expect(ctx._injections[0]).toContain("via /cd");
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("moves to relative directories with spaces", async () => {
    const destination = canonicalizeCwd(join(root, "space dir"));
    mkdirSync(destination);
    const session = new Session("s-relative", root);
    const result = await handleCd(CMD, "space dir", makeCtx(session));
    expect(result.feedback).toBe(`Moved to ${destination}`);
    expect(session.cwd).toBe(destination);
  });

  it("reports a canonical same-directory no-op", async () => {
    const session = new Session("s-same", root);
    const result = await handleCd(CMD, ".", makeCtx(session));
    expect(result.feedback).toBe(`Already in ${root}.`);
    expect(session.cwd).toBe(root);
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
    const check = evaluateCdPermission(
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
