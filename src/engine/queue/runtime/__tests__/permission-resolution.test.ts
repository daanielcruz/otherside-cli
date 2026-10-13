import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { type AgentContext, withSpawnedAgentScope } from "@/engine/agents/agent-context.ts";
import {
  replaceSnapshot as replaceSkillSnapshot,
  type Skill,
  snapshot as skillSnapshot,
} from "@/engine/skills/registry.ts";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import { dispatch as dispatchTool, type PermissionDecision } from "@/engine/tools/pipeline.ts";
import { runWithPreToolUseHookPermissionSignal } from "@/engine/tools/pretooluse-hook-permission-context.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import {
  answer as answerPermission,
  clear as clearPermissionQueue,
  notifyPermissionContextChanged,
  type PendingPermission,
  PermissionResults,
  peek as peekPermission,
  subscribe as subscribePermissions,
} from "@/kernel/channels/permission.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import { firePermissionDeniedHooks } from "@/kernel/hooks/handler.ts";
import {
  directoryPathPattern,
  filePathPattern,
  permissionPatternMatches,
  RuleStore,
} from "@/kernel/permissions/index.ts";
import { loadRules, saveRules } from "@/kernel/permissions/persist.ts";
import {
  type PermissionBehavior,
  type PermissionRule,
  serializeRuleValue,
} from "@/kernel/permissions/types.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { RequestContext, ScopedToolHandler } from "@/kernel/std/types/request.ts";
import { autoMemDir } from "@/kernel/storage/memory/entrypoint.ts";
import {
  type CompoundBashProbes,
  compoundBashDecision,
  isWorkspaceRead,
  type PermissionResolutionDeps,
  resolvePermission,
} from "../permission-resolution.ts";
import {
  AGENT_TOOL_REJECTED_RESULT,
  AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX,
  USER_REJECTED_TOOL_RESULT,
  USER_REJECTED_WITH_FEEDBACK_PREFIX,
} from "../rejection-text.ts";

/** What a prompt the user turned down without directions resolves to. */
const USER_REJECTED: PermissionDecision = {
  kind: "deny",
  message: USER_REJECTED_TOOL_RESULT,
  stopsTurn: true,
};
/** What an agent's prompt the user turned down without directions resolves to. */
const AGENT_REJECTED: PermissionDecision = { kind: "deny", message: AGENT_TOOL_REJECTED_RESULT };

describe("isWorkspaceRead", () => {
  const fsRoot = parse(process.cwd()).root;
  const root = join(fsRoot, "mock-dir");
  const inside = join(root, "file.ts");
  const nested = join(root, "sub", "deep.ts");
  const outsideRoot = join(fsRoot, "mock-dir-out");
  const outsideFile = join(outsideRoot, "secret.ts");

  const symlinks = new Map<string, string>();
  symlinks.set(join(root, "link.ts"), outsideFile);

  const existingPaths = new Set<string>([
    fsRoot,
    root,
    inside,
    join(root, "sub"),
    nested,
    outsideRoot,
    outsideFile,
  ]);

  const mockRealpath = (path: string): string => {
    const normalized = path === fsRoot ? path : path.replace(/[\\/]+$/, "");
    if (symlinks.has(normalized)) {
      return symlinks.get(normalized)!;
    }
    if (existingPaths.has(normalized)) {
      return normalized;
    }
    const err = new Error(`ENOENT: no such file or directory, realpath '${path}'`) as Error & {
      code?: string;
    };
    err.code = "ENOENT";
    throw err;
  };

  it("auto-allows a Read of an absolute path inside cwd", () => {
    expect(isWorkspaceRead("Read", { file_path: inside }, root, mockRealpath)).toBe(true);
    expect(isWorkspaceRead("Read", { file_path: nested }, root, mockRealpath)).toBe(true);
  });

  it("auto-allows a Read of a relative path resolved against cwd", () => {
    expect(isWorkspaceRead("Read", { file_path: "file.ts" }, root, mockRealpath)).toBe(true);
    expect(isWorkspaceRead("Read", { file_path: "sub/deep.ts" }, root, mockRealpath)).toBe(true);
  });

  it("auto-allows a Read of a not-yet-existing path inside cwd", () => {
    expect(isWorkspaceRead("Read", { file_path: join(root, "new.ts") }, root, mockRealpath)).toBe(
      true,
    );
  });

  it("does NOT auto-allow a Read outside cwd", () => {
    expect(isWorkspaceRead("Read", { file_path: outsideFile }, root, mockRealpath)).toBe(false);
    expect(isWorkspaceRead("Read", { file_path: "../escape.ts" }, root, mockRealpath)).toBe(false);
  });

  it("does NOT auto-allow a symlink inside cwd that escapes cwd", () => {
    const link = join(root, "link.ts");
    expect(isWorkspaceRead("Read", { file_path: link }, root, mockRealpath)).toBe(false);
  });

  it("only applies to read-only path tools", () => {
    expect(isWorkspaceRead("Bash", { file_path: inside }, root, mockRealpath)).toBe(false);
    expect(isWorkspaceRead("Write", { file_path: inside }, root, mockRealpath)).toBe(false);
    expect(isWorkspaceRead("Edit", { file_path: inside }, root, mockRealpath)).toBe(false);
  });

  it("returns false when there is no file_path", () => {
    expect(isWorkspaceRead("Read", {}, root, mockRealpath)).toBe(false);
    expect(isWorkspaceRead("Read", { file_path: "" }, root, mockRealpath)).toBe(false);
    expect(isWorkspaceRead("Read", null, root, mockRealpath)).toBe(false);
  });
});

function bashPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function withPermissionFixture<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "permission-resolution-"));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  try {
    return await run(cwd);
  } finally {
    if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    clearPermissionQueue();
    rmSync(root, { recursive: true, force: true });
  }
}

function resolutionDeps(
  cwd: string,
  mode: PermissionMode,
  sessionAllowedToolPatterns = new Set<string>(),
  dispatch: (action: unknown) => void = () => {},
  additionalWorkingDirectories = new Set<string>(),
  config: Pick<UserConfig, "hooks"> = {},
): PermissionResolutionDeps {
  return {
    injections: { push: () => {}, drain: () => [], peek: () => [] },
    sessionAllowedToolPatterns,
    agentDeps: {
      broker: { read: () => ({ permissionMode: mode }), dispatch },
      session: {
        id: "permission-resolution-session",
        cwd,
        additionalWorkingDirectories,
      },
      config,
    },
  } as unknown as PermissionResolutionDeps;
}

async function waitForPermission(): Promise<PendingPermission> {
  for (let i = 0; i < 100; i += 1) {
    const pending = peekPermission();
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("permission ask never surfaced");
}

function forkContext(): AgentContext {
  return {
    agentId: "fork-1",
    depth: 1,
    parentSessionId: "parent",
    agentType: "subagent",
    subagentName: "worker",
  };
}

describe("MCP wildcard allow rules", () => {
  it("asks in default mode when a persisted wildcard server allow has no exact match", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "allow",
            ruleValue: { toolName: "mcp__prod*" },
          },
        ],
        cwd,
      );

      const decisionPromise = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-mcp-wildcard-server-allow",
        name: "mcp__production__run",
        input: {},
      });
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("mcp__production__run");
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(USER_REJECTED);
    });
  });

  it("keeps explicit deny and ask rules ahead of yolo for read-only MCP tools", async () => {
    await withPermissionFixture(async (cwd) => {
      const toolName = "mcp__inspector__first_read";
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName } }],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-mcp-read-only-deny",
          name: toolName,
          input: {},
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName } }],
        cwd,
      );
      const decisionPromise = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-mcp-read-only-ask",
        name: toolName,
        input: {},
      });
      const pending = await waitForPermission();
      expect(pending.toolName).toBe(toolName);
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(USER_REJECTED);
    });
  });

  it("does not apply retrying PermissionDenied hooks to explicit or user denials", async () => {
    await withPermissionFixture(async (cwd) => {
      const retryHookConfig = {
        hooks: {
          permissionDenied: [
            {
              matcher: "*",
              command:
                'printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}\'',
            },
          ],
        },
      } satisfies Pick<UserConfig, "hooks">;
      const hookResult = await firePermissionDeniedHooks(retryHookConfig as UserConfig, {
        kind: "permissionDenied",
        ctx: { toolName: "Write", toolInput: "{}", toolUseId: "t-hook", reason: "test" },
      });
      expect(hookResult.retry).toBe(true);

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      const explicitDeny = await resolvePermission(
        resolutionDeps(cwd, "yolo", new Set(), () => {}, new Set(), retryHookConfig),
        { id: "t-hook-explicit-deny", name: "Write", input: { file_path: join(cwd, "x.ts") } },
      );
      expect(explicitDeny).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      const userDeny = resolvePermission(
        resolutionDeps(cwd, "yolo", new Set(), () => {}, new Set(), retryHookConfig),
        { id: "t-hook-user-deny", name: "Write", input: { file_path: join(cwd, "x.ts") } },
      );
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("Write");
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await userDeny).toEqual(USER_REJECTED);
    });
  });
});

describe("session grants made inside an agent", () => {
  it("cover the same call on the main session and in other agents", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const outsideDir = join(cwd, "..", "agent-granted");
      mkdirSync(outsideDir);
      const call = (id: string): ToolCall => ({
        id,
        name: "Read",
        input: { file_path: join(outsideDir, "notes.txt") },
      });

      const agentAsk = withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(deps, call("t-agent-grant")),
      );
      const pending = await waitForPermission();
      expect(pending.source?.name).toBe("worker");
      answerPermission(
        pending.id,
        PermissionResults.allowSession(pending.rule!, pending.suggestions),
      );
      expect(await agentAsk).toBe("allow");
      expect(sessionGrants.size).toBeGreaterThan(0);

      expect(await resolvePermission(deps, call("t-main-after-agent-grant"))).toBe("allow");
      expect(
        await withSpawnedAgentScope({ ...forkContext(), agentId: "fork-2" }, () =>
          resolvePermission(deps, call("t-sibling-after-agent-grant")),
        ),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });
});

/** Deps whose broker holds a live permission mode, as a session's own broker does. */
function liveModeDeps(
  cwd: string,
  initial: PermissionMode,
  sessionAllowedToolPatterns = new Set<string>(),
): { deps: PermissionResolutionDeps; setMode: (mode: PermissionMode) => void } {
  let mode = initial;
  const base = resolutionDeps(cwd, initial, sessionAllowedToolPatterns);
  const deps = {
    ...base,
    agentDeps: {
      ...base.agentDeps,
      broker: {
        read: () => ({ permissionMode: mode }),
        dispatch: (action: { kind: string; mode?: PermissionMode }) => {
          if (action.kind === "set_permission_mode" && action.mode) mode = action.mode;
        },
      },
    },
  } as unknown as PermissionResolutionDeps;
  return { deps, setMode: (next) => (mode = next) };
}

function bashCall(id: string, command: string): ToolCall {
  return { id, name: "Bash", input: { command } };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never held");
}

async function withQueueSize<T>(run: (size: () => number) => Promise<T>): Promise<T> {
  let size = 0;
  const stop = subscribePermissions((queue) => {
    size = queue.length;
  });
  try {
    return await run(() => size);
  } finally {
    stop();
  }
}

describe("waiting prompts re-check when the permission context changes", () => {
  it("settles a waiting prompt once a lasting approval's rule covers it", async () => {
    await withPermissionFixture((cwd) =>
      withQueueSize(async (queueSize) => {
        const deps = resolutionDeps(cwd, "default");
        const first = resolvePermission(deps, bashCall("t-recheck-first", "npm test"));
        await waitForPermission();
        const second = resolvePermission(deps, bashCall("t-recheck-second", "npm test --watch"));
        await until(() => queueSize() === 2);

        const pending = peekPermission()!;
        expect(pending.rule).toBe("Bash(npm test *)");
        answerPermission(pending.id, PermissionResults.allowAlways(pending.rule!));

        expect(await first).toBe("allow");
        expect(await second).toBe("allow");
        expect(peekPermission()).toBeNull();
      }),
    );
  });

  it("leaves the other prompts waiting after a one-time approval", async () => {
    await withPermissionFixture((cwd) =>
      withQueueSize(async (queueSize) => {
        const deps = resolutionDeps(cwd, "default");
        const first = resolvePermission(deps, bashCall("t-once-first", "npm test"));
        await waitForPermission();
        const second = resolvePermission(deps, bashCall("t-once-second", "npm test --watch"));
        await until(() => queueSize() === 2);

        answerPermission(peekPermission()!.id, PermissionResults.allow());
        expect(await first).toBe("allow");
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(queueSize()).toBe(1);

        answerPermission(peekPermission()!.id, PermissionResults.deny());
        expect(await second).toEqual(USER_REJECTED);
      }),
    );
  });

  it("settles waiting prompts a mode switch allows, never one an ask rule holds", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Bash", ruleContent: "make deploy *" },
          },
        ],
        cwd,
      );
      const { deps, setMode } = liveModeDeps(cwd, "default");

      await withQueueSize(async (queueSize) => {
        const allowedByMode = resolvePermission(deps, bashCall("t-mode-open", "npm test"));
        await waitForPermission();
        const heldByRule = resolvePermission(deps, bashCall("t-mode-held", "make deploy"));
        await until(() => queueSize() === 2);

        setMode("yolo");
        notifyPermissionContextChanged();

        expect(await allowedByMode).toBe("allow");
        expect(queueSize()).toBe(1);
        const held = peekPermission()!;
        expect(held.argsPreview).toContain("make deploy");
        answerPermission(held.id, PermissionResults.deny());
        expect(await heldByRule).toEqual(USER_REJECTED);
      });
    });
  });
});

describe("lasting approvals of compound commands", () => {
  it("saves a rule for each segment nothing allows yet, and the compound runs next time", async () => {
    await withPermissionFixture(async (cwd) => {
      mkdirSync(join(cwd, "sub"));
      const deps = resolutionDeps(cwd, "default");

      const withCd = resolvePermission(deps, bashCall("t-compound-cd", "cd sub && npm test"));
      const cdPending = await waitForPermission();
      expect(cdPending.rule).toBe("Bash(npm test *)");
      expect(cdPending.rules).toBeUndefined();
      answerPermission(cdPending.id, PermissionResults.allowAlways(cdPending.rule!));
      expect(await withCd).toBe("allow");
      expect(
        await resolvePermission(deps, bashCall("t-compound-cd-again", "cd sub && npm test")),
      ).toBe("allow");

      const pair = resolvePermission(
        deps,
        bashCall("t-compound-pair", "cargo build && make check"),
      );
      const pairPending = await waitForPermission();
      expect(pairPending.rule).toBeNull();
      expect(pairPending.reason).toBe("This command requires approval");
      expect(pairPending.rules).toEqual(["Bash(cargo build *)", "Bash(make check *)"]);
      answerPermission(pairPending.id, PermissionResults.allowAlwaysAll(pairPending.rules!));
      expect(await pair).toBe("allow");
      expect(
        await resolvePermission(
          deps,
          bashCall("t-compound-pair-again", "cargo build && make check"),
        ),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("saves a segment with no second command word exactly as it ran", async () => {
    await withPermissionFixture(async (cwd) => {
      const command = "make --version && cmake --version";
      const first = resolvePermission(
        resolutionDeps(cwd, "default"),
        bashCall("t-versions", command),
      );
      const pending = await waitForPermission();
      expect(pending.rules).toEqual(["Bash(make --version)", "Bash(cmake --version)"]);
      answerPermission(pending.id, PermissionResults.allowAlwaysAll(pending.rules!));
      expect(await first).toBe("allow");
      const deps = resolutionDeps(cwd, "default");
      expect(await resolvePermission(deps, bashCall("t-versions-2", command))).toBe("allow");
      const other = resolvePermission(deps, bashCall("t-make-other", "make install"));
      const otherPending = await waitForPermission();
      answerPermission(otherPending.id, PermissionResults.deny());
      expect(await other).toEqual(USER_REJECTED);
    });
  });

  it("offers at most five rules, leftmost first", async () => {
    await withPermissionFixture(async (cwd) => {
      const command = ["a", "b", "c", "d", "e", "f", "g"].map((target) => `make ${target}`);
      const decision = resolvePermission(
        resolutionDeps(cwd, "default"),
        bashCall("t-compound-cap", command.join(" && ")),
      );
      const pending = await waitForPermission();
      expect(pending.rules).toEqual(command.slice(0, 5).map((segment) => `Bash(${segment} *)`));
      answerPermission(pending.id, PermissionResults.deny());
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("still asks before a read-only segment reads outside the workspace", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("npm test *")], cwd);
      const deps = resolutionDeps(cwd, "default");
      const outsideFile = bashPath(join(cwd, "..", "outside.txt"));

      expect(
        await resolvePermission(deps, bashCall("t-compound-inside-read", "npm test && cat a.txt")),
      ).toBe("allow");
      const outside = resolvePermission(
        deps,
        bashCall("t-compound-outside-read", `npm test && cat ${outsideFile}`),
      );
      const pending = await waitForPermission();
      expect(pending.argsPreview).toContain("outside.txt");
      answerPermission(pending.id, PermissionResults.deny());
      expect(await outside).toEqual(USER_REJECTED);
    });
  });
});

describe("Bash reads outside the workspace", () => {
  function outsideDirectory(cwd: string, name: string): string {
    const directory = join(cwd, "..", name);
    mkdirSync(directory);
    return directory;
  }

  it("offer the directory for the project, and that grant covers the next read there", async () => {
    await withPermissionFixture(async (cwd) => {
      const deps = resolutionDeps(cwd, "default");
      const notes = outsideDirectory(cwd, "notes");
      const other = outsideDirectory(cwd, "other");

      const first = resolvePermission(
        deps,
        bashCall("t-bash-outside-read", `cat ${bashPath(join(notes, "a.txt"))}`),
      );
      const pending = await waitForPermission();
      expect(pending.rule).toBeNull();
      expect(pending.readDirectories).toEqual([resolve(notes)]);
      expect(
        pending.suggestions?.every(
          (update) => "destination" in update && update.destination === "localSettings",
        ),
      ).toBe(true);
      answerPermission(pending.id, PermissionResults.allowSession(null, pending.suggestions));
      expect(await first).toBe("allow");

      // The grant is the project's: a fresh session reads it back from settings.
      const next = resolutionDeps(cwd, "default");
      for (const command of [`head ${join(notes, "b.txt")}`, `wc -l ${join(notes, "c.txt")}`]) {
        expect(await resolvePermission(next, bashCall(`t-${command}`, bashPath(command)))).toBe(
          "allow",
        );
      }
      const elsewhere = resolvePermission(
        deps,
        bashCall("t-bash-other-dir", `cat ${bashPath(join(other, "a.txt"))}`),
      );
      const otherPending = await waitForPermission();
      expect(otherPending.readDirectories).toEqual([resolve(other)]);
      answerPermission(otherPending.id, PermissionResults.deny());
      expect(await elsewhere).toEqual(USER_REJECTED);
    });
  });

  it("are covered by the directory a Read approval opened", async () => {
    await withPermissionFixture(async (cwd) => {
      const deps = resolutionDeps(cwd, "default");
      const notes = outsideDirectory(cwd, "notes");

      const read = resolvePermission(deps, {
        id: "t-read-outside",
        name: "Read",
        input: { file_path: join(notes, "a.txt") },
      });
      const pending = await waitForPermission();
      expect(pending.readDirectories).toEqual([resolve(notes)]);
      // The directory settles the read, so no rule for the one file is offered.
      expect(pending.rule).toBeNull();
      expect(pending.rules).toBeUndefined();
      expect(
        pending.suggestions?.every(
          (update) => "destination" in update && update.destination === "session",
        ),
      ).toBe(true);
      answerPermission(
        pending.id,
        PermissionResults.allowSession(pending.rule, pending.suggestions),
      );
      expect(await read).toBe("allow");

      expect(
        await resolvePermission(
          deps,
          bashCall("t-bash-after-read-grant", `cat ${bashPath(join(notes, "b.txt"))}`),
        ),
      ).toBe("allow");
    });
  });

  it("are denied by a Read deny rule, ahead of the directory grant and yolo", async () => {
    await withPermissionFixture(async (cwd) => {
      const notes = outsideDirectory(cwd, "notes");
      const secret = join(notes, "secret.txt");
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Read", ruleContent: secret },
          },
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Read", ruleContent: join(cwd, ".env") },
          },
        ],
        cwd,
      );
      const grants = new Set([`Read(${join(notes, "*")})`]);

      for (const command of [`cat ${secret}`, `npm test && head ${secret}`, "cat .env"]) {
        expect(
          await resolvePermission(
            resolutionDeps(cwd, "yolo", grants),
            bashCall(`t-${command}`, bashPath(command)),
          ),
        ).toBe("deny");
      }
      expect(peekPermission()).toBeNull();
    });
  });

  it("after cd outside the workspace offer that directory, and the grant covers the next one", async () => {
    await withPermissionFixture(async (cwd) => {
      const deps = resolutionDeps(cwd, "default");
      const notes = outsideDirectory(cwd, "notes");

      const first = resolvePermission(
        deps,
        bashCall("t-cd-outside", `cd ${bashPath(notes)} && ls`),
      );
      const pending = await waitForPermission();
      expect(pending.rule).toBeNull();
      expect(pending.readDirectories).toEqual([resolve(notes)]);
      answerPermission(pending.id, PermissionResults.allowSession(null, pending.suggestions));
      expect(await first).toBe("allow");

      for (const command of [`cd ${notes} && ls -la`, `cd ${notes} && cat a.txt`]) {
        expect(await resolvePermission(deps, bashCall(`t-${command}`, bashPath(command)))).toBe(
          "allow",
        );
      }
      const escaping = resolvePermission(
        deps,
        bashCall("t-cd-escape", `cd ${bashPath(notes)} && cat ../../elsewhere.txt`),
      );
      const escapingPending = await waitForPermission();
      answerPermission(escapingPending.id, PermissionResults.deny());
      expect(await escaping).toEqual(USER_REJECTED);
    });
  });
});

describe("Skill calls", () => {
  function registeredSkill(name: string, body: string): Skill {
    return {
      name,
      aliases: [],
      description: name,
      whenToUse: "",
      argumentHint: null,
      userInvocable: true,
      modelInvocable: true,
      context: "inline",
      body,
      builtin: false,
      source: "project",
      authorModelLock: false,
    };
  }

  function skillCall(id: string, skill: string): ToolCall {
    return { id, name: "Skill", input: { skill } };
  }

  it("run a skill that only carries instructions without a prompt; deny rules still apply", async () => {
    const previous = skillSnapshot();
    // Loaded after the tool index so the Skill handler's own imports settle first.
    const { Skill: SkillTool } = await import("@/engine/tools/builtins/skill.ts");
    toolRegistry.register(SkillTool);
    try {
      replaceSkillSnapshot([
        registeredSkill("notes", "Summarize the notes."),
        registeredSkill("release", "Current branch: !`git branch --show-current`"),
      ]);
      await withPermissionFixture(async (cwd) => {
        const deps = resolutionDeps(cwd, "default");
        expect(await resolvePermission(deps, skillCall("t-skill-plain", "notes"))).toBe("allow");

        const shell = resolvePermission(deps, skillCall("t-skill-shell", "release"));
        const pending = await waitForPermission();
        expect(pending.rule).toBe("Skill(release)");
        answerPermission(pending.id, PermissionResults.deny());
        expect(await shell).toEqual(USER_REJECTED);

        await saveRules(
          [
            {
              source: "localSettings",
              ruleBehavior: "deny",
              ruleValue: { toolName: "Skill", ruleContent: "not:*" },
            },
          ],
          cwd,
        );
        expect(await resolvePermission(deps, skillCall("t-skill-denied", "notes"))).toBe("deny");
      });
    } finally {
      toolRegistry.unregister("Skill");
      replaceSkillSnapshot(previous);
    }
  });
});

describe("file rules written relative", () => {
  it("cover the file wherever it sits under the project, from Read and from Bash", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Read", ruleContent: "./.env" },
          },
        ],
        cwd,
      );
      mkdirSync(join(cwd, "apps"));
      const deps = resolutionDeps(cwd, "yolo");
      const read = (id: string, path: string): ToolCall => ({
        id,
        name: "Read",
        input: { file_path: path },
      });

      expect(await resolvePermission(deps, read("t-relative-root", join(cwd, ".env")))).toBe(
        "deny",
      );
      expect(
        await resolvePermission(deps, read("t-relative-nested", join(cwd, "apps", ".env"))),
      ).toBe("deny");
      expect(await resolvePermission(deps, bashCall("t-relative-cat", "cat apps/.env"))).toBe(
        "deny",
      );
      expect(await resolvePermission(deps, read("t-relative-other", join(cwd, "README.md")))).toBe(
        "allow",
      );
    });
  });
});

describe("Bash writes and file deny rules", () => {
  it("deny a write an Edit deny rule covers, even in yolo", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Edit", ruleContent: join(cwd, "locked", "*") },
          },
        ],
        cwd,
      );
      mkdirSync(join(cwd, "locked"));
      expect(
        await resolvePermission(
          resolutionDeps(cwd, "yolo"),
          bashCall("t-bash-denied-write", "touch locked/a.txt"),
        ),
      ).toBe("deny");
      expect(
        await resolvePermission(
          resolutionDeps(cwd, "yolo"),
          bashCall("t-bash-open-write", "touch open.txt"),
        ),
      ).toBe("allow");
    });
  });
});

describe("lasting approvals of web tools", () => {
  it("save the fetched host and the whole search tool, and the next call runs", async () => {
    await withPermissionFixture(async (cwd) => {
      const cases = [
        {
          name: "WebFetch",
          first: { url: "https://example.com/", prompt: "Summarize" },
          next: { url: "https://example.com/other", prompt: "List links" },
          rule: "WebFetch(domain:example.com)",
        },
        {
          name: "WebSearch",
          first: { query: "first query" },
          next: { query: "second query" },
          rule: "WebSearch",
        },
      ];
      for (const { name, first, next, rule } of cases) {
        const asked = resolvePermission(resolutionDeps(cwd, "default"), {
          id: `t-${name}`,
          name,
          input: first,
        });
        const pending = await waitForPermission();
        expect(pending.rule).toBe(rule);
        answerPermission(pending.id, PermissionResults.allowAlways(pending.rule!));
        expect(await asked).toBe("allow");
        expect(
          await resolvePermission(resolutionDeps(cwd, "default"), {
            id: `t-${name}-next`,
            name,
            input: next,
          }),
        ).toBe("allow");
      }
    });
  });
});

describe("lasting approvals of command writes", () => {
  it("open the working directory for the project, and the next write there runs", async () => {
    await withPermissionFixture(async (cwd) => {
      const first = resolvePermission(
        resolutionDeps(cwd, "default"),
        bashCall("t-touch", "touch created.txt"),
      );
      const pending = await waitForPermission();
      expect(pending.rule).toBeNull();
      expect(pending.rules).toBeUndefined();
      expect(pending.reason).toBeUndefined();
      expect(pending.writeDirectories).toEqual([cwd]);
      answerPermission(pending.id, { decision: "allow", updates: pending.suggestions ?? [] });
      expect(await first).toBe("allow");

      // A fresh session reads the grant back from the project's settings.
      const next = resolutionDeps(cwd, "default");
      for (const command of ["touch other.txt", "mkdir logs"]) {
        expect(await resolvePermission(next, bashCall(`t-${command}`, command))).toBe("allow");
      }
      expect(peekPermission()).toBeNull();
    });
  });

  it("save a compound's write as a directory and its other segments as rules", async () => {
    await withPermissionFixture(async (cwd) => {
      const command = "touch created.txt && make check";
      const first = resolvePermission(resolutionDeps(cwd, "default"), bashCall("t-mixed", command));
      const pending = await waitForPermission();
      expect(pending.rule).toBeNull();
      expect(pending.rules).toEqual(["Bash(make check *)"]);
      expect(pending.writeDirectories).toEqual([cwd]);
      answerPermission(pending.id, { decision: "allow", updates: pending.suggestions ?? [] });
      expect(await first).toBe("allow");
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), bashCall("t-mixed-2", command)),
      ).toBe("allow");
    });
  });
});

describe("writes outside the workspace", () => {
  it("open the directory for the project, and Bash and Write both reuse that approval", async () => {
    await withPermissionFixture(async (cwd) => {
      const { deps } = liveModeDeps(cwd, "default");
      const shared = join(cwd, "..", "shared");
      mkdirSync(shared);

      const first = resolvePermission(
        deps,
        bashCall("t-bash-outside-write", `touch ${bashPath(join(shared, "a.txt"))}`),
      );
      const pending = await waitForPermission();
      expect(pending.rule).toBeNull();
      expect(pending.writeDirectories).toEqual([resolve(shared)]);
      answerPermission(pending.id, { decision: "allow", updates: pending.suggestions ?? [] });
      expect(await first).toBe("allow");

      for (const command of [`touch ${join(shared, "b.txt")}`, `mkdir ${join(shared, "logs")}`]) {
        expect(await resolvePermission(deps, bashCall(`t-${command}`, bashPath(command)))).toBe(
          "allow",
        );
      }
      expect(
        await resolvePermission(deps, {
          id: "t-write-after-bash-grant",
          name: "Write",
          input: { file_path: join(shared, "c.txt"), content: "c" },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("covers Bash writes after a Write approval opened the directory", async () => {
    await withPermissionFixture(async (cwd) => {
      const { deps } = liveModeDeps(cwd, "default");
      const shared = join(cwd, "..", "shared");
      mkdirSync(shared);

      const write = resolvePermission(deps, {
        id: "t-write-outside",
        name: "Write",
        input: { file_path: join(shared, "a.txt"), content: "a" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, PermissionResults.allowSessionEdits(pending.editDirectory));
      expect(await write).toBe("allow");

      expect(
        await resolvePermission(
          deps,
          bashCall("t-bash-after-write-grant", `touch ${bashPath(join(shared, "b.txt"))}`),
        ),
      ).toBe("allow");
    });
  });
});

describe("fork inherits the parent's session-scoped approval (AGENT-PERM-001)", () => {
  it("does not re-prompt a fresh named Agent fork for an outside Read pattern the parent already granted for the session", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const outsideDir = join(cwd, "..", "shared (copy)");
      mkdirSync(outsideDir);
      const filePath = join(outsideDir, "notes.txt");

      // The parent (main turn, no AgentContext) grants a session-scoped allow
      // for reads under this outside directory.
      const parentAsk = resolvePermission(deps, {
        id: "t-parent-grant",
        name: "Read",
        input: { file_path: filePath },
      });
      const pending = await waitForPermission();
      answerPermission(
        pending.id,
        PermissionResults.allowSession(pending.rule!, pending.suggestions),
      );
      expect(await parentAsk).toBe("allow");
      expect(sessionGrants.size).toBeGreaterThan(0);

      // A fresh named Agent fork spawns afterward and makes the identical Read
      // call. It must be auto-allowed off the parent's grant, never re-prompted.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const childDecision = await withSpawnedAgentScope(forkContext(), () =>
          resolvePermission(
            deps,
            {
              id: "t-child-same-call",
              name: "Read",
              input: { file_path: filePath },
            },
            controller.signal,
          ),
        );
        expect(childDecision).toBe("allow");
      } finally {
        clearTimeout(timeout);
      }
      expect(peekPermission()).toBeNull();
    });
  });

  it("still asks for a matching call in a sibling fork whose parent has NOT granted anything", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const outsideDir = join(cwd, "..", "ungranted");
      mkdirSync(outsideDir);

      const decisionPromise = withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(deps, {
          id: "t-child-no-grant",
          name: "Read",
          input: { file_path: join(outsideDir, "secret.txt") },
        }),
      );
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(AGENT_REJECTED);
    });
  });

  it("keeps an explicit deny rule ahead of an inherited parent session-allow grant inside a fork", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const outsideDir = join(cwd, "..", "denied-outside");
      mkdirSync(outsideDir);
      const filePath = join(outsideDir, "blocked.txt");

      // Parent grants a broad session-scoped Read allow that would otherwise
      // cover this file.
      sessionGrants.add(`Read:${outsideDir}/*`);
      // A persisted deny rule targets the exact same file.
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Read", ruleContent: filePath },
          },
        ],
        cwd,
      );

      const childDecision = await withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(deps, {
          id: "t-child-deny-over-inherited-allow",
          name: "Read",
          input: { file_path: filePath },
        }),
      );
      expect(childDecision).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps an explicit ask rule ahead of an inherited parent session-allow grant inside a fork", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>(["Bash:git push*"]);
      const deps = resolutionDeps(cwd, "yolo", sessionGrants);
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "Bash" } }],
        cwd,
      );

      const decisionPromise = withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(deps, {
          id: "t-child-ask-over-inherited-allow",
          name: "Bash",
          input: { command: "git push origin main" },
        }),
      );
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(AGENT_REJECTED);
    });
  });
});

describe("subagent permission prompts", () => {
  it("auto-denies a background subagent ask without enqueueing a prompt", async () => {
    await withPermissionFixture(async (cwd) => {
      const context = {
        ...forkContext(),
        shouldAvoidPermissionPrompts: true,
      };
      const decision = await withSpawnedAgentScope(context, () =>
        resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-background-ask",
          name: "ProbeTool",
          input: {},
        }),
      );

      expect(decision).toEqual({
        kind: "deny",
        message:
          "Permission to use ProbeTool has been denied. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.",
      });
      expect(peekPermission()).toBeNull();
    });
  });

  it("bubbles a backgrounded fork's Bash rm-outside-workspace ask instead of auto-denying (AGENT-PERM-002)", async () => {
    await withPermissionFixture(async (cwd) => {
      // Mirrors the AgentContext a backgrounded fork now runs under: dispatchFork
      // no longer sets shouldAvoidPermissionPrompts just because runInBackground
      // is true (forks always keep a parent turn able to answer, per
      // fork/types.ts), so this must bubble rather than auto-deny.
      const backgroundedForkContext = forkContext();
      const decisionPromise = withSpawnedAgentScope(backgroundedForkContext, () =>
        resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-fork-background-rm-outside",
          name: "Bash",
          input: { command: `rm ${bashPath(join(cwd, "..", "outside.txt"))}` },
        }),
      );
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("Bash");
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(AGENT_REJECTED);
    });
  });

  it("keeps an explicit deny rule ahead of a backgrounded fork's ask, without a prompt (AGENT-PERM-002)", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Bash" } }],
        cwd,
      );
      const decision = await withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-fork-background-rm-outside-denied-by-rule",
          name: "Bash",
          input: { command: `rm ${bashPath(join(cwd, "..", "outside.txt"))}` },
        }),
      );
      expect(decision).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("still auto-denies a genuinely detached (named background subagent) ask, unaffected by the fork fix", async () => {
    await withPermissionFixture(async (cwd) => {
      const decision = await withSpawnedAgentScope(
        { ...forkContext(), shouldAvoidPermissionPrompts: true },
        () =>
          resolvePermission(resolutionDeps(cwd, "default"), {
            id: "t-named-background-rm-outside",
            name: "Bash",
            input: { command: `rm ${bashPath(join(cwd, "..", "outside.txt"))}` },
          }),
      );
      expect(decision).toEqual({
        kind: "deny",
        message: expect.stringContaining("Permission to use Bash has been denied."),
      });
      expect(peekPermission()).toBeNull();
    });
  });

  it("bubbles a named background subagent's ask to the live permission UI in an interactive TUI session (AGENT-PERM-003)", async () => {
    await withPermissionFixture(async (cwd) => {
      setRuntimeKind("interactive");
      try {
        const decisionPromise = withSpawnedAgentScope(
          { ...forkContext(), shouldAvoidPermissionPrompts: true },
          () =>
            resolvePermission(resolutionDeps(cwd, "default"), {
              id: "t-named-background-interactive-bubble",
              name: "Bash",
              input: { command: `rm ${bashPath(join(cwd, "..", "outside.txt"))}` },
            }),
        );
        const pending = await waitForPermission();
        expect(pending.toolName).toBe("Bash");
        expect(pending.source).toEqual({ name: "worker", depth: 1 });
        answerPermission(pending.id, { decision: "deny", updates: [] });
        expect(await decisionPromise).toEqual(AGENT_REJECTED);
      } finally {
        setRuntimeKind(null);
      }
    });
  });

  it("still auto-denies a named background subagent's ask outside an interactive session (piped, AGENT-PERM-003)", async () => {
    await withPermissionFixture(async (cwd) => {
      setRuntimeKind("piped");
      try {
        const decision = await withSpawnedAgentScope(
          { ...forkContext(), shouldAvoidPermissionPrompts: true },
          () =>
            resolvePermission(resolutionDeps(cwd, "default"), {
              id: "t-named-background-piped-autodeny",
              name: "Bash",
              input: { command: `rm ${bashPath(join(cwd, "..", "outside.txt"))}` },
            }),
        );
        expect(decision).toEqual({
          kind: "deny",
          message: expect.stringContaining("Permission to use Bash has been denied."),
        });
        expect(peekPermission()).toBeNull();
      } finally {
        setRuntimeKind(null);
      }
    });
  });

  it("keeps an explicit deny rule ahead of a named background subagent's bubbled ask in an interactive session (AGENT-PERM-003)", async () => {
    await withPermissionFixture(async (cwd) => {
      setRuntimeKind("interactive");
      try {
        await saveRules(
          [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Bash" } }],
          cwd,
        );
        const decision = await withSpawnedAgentScope(
          { ...forkContext(), shouldAvoidPermissionPrompts: true },
          () =>
            resolvePermission(resolutionDeps(cwd, "default"), {
              id: "t-named-background-interactive-explicit-deny",
              name: "Bash",
              input: { command: `rm ${bashPath(join(cwd, "..", "outside.txt"))}` },
            }),
        );
        expect(decision).toBe("deny");
        expect(peekPermission()).toBeNull();
      } finally {
        setRuntimeKind(null);
      }
    });
  });

  it("bubbles an outside Write from a foreground named subagent", async () => {
    await withPermissionFixture(async (cwd) => {
      const decisionPromise = withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-foreground-named-write",
          name: "Write",
          input: { file_path: join(cwd, "..", "outside.ts"), content: "outside" },
        }),
      );
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("Write");
      expect(pending.source).toEqual({ name: "worker", depth: 1 });
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(AGENT_REJECTED);
    });
  });

  it("keeps explicit deny and ask rules ahead of foreground permission mode allowances", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      expect(
        await withSpawnedAgentScope(forkContext(), () =>
          resolvePermission(resolutionDeps(cwd, "yolo"), {
            id: "t-foreground-named-deny",
            name: "Write",
            input: { file_path: join(cwd, "allowed-by-yolo.ts"), content: "blocked" },
          }),
        ),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      const askDecision = withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-foreground-named-ask",
          name: "Write",
          input: { file_path: join(cwd, "would-be-yolo.ts"), content: "ask" },
        }),
      );
      const pending = await waitForPermission();
      expect(pending.source).toEqual({ name: "worker", depth: 1 });
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await askDecision).toEqual(AGENT_REJECTED);
    });
  });
});

describe("PreToolUse hook permissionDecision allow/ask (PERM-HOOK-ALLOW-BYPASS-001)", () => {
  it("bypasses headless (--print) auto-deny on an explicit hook allow when no deny/ask rule matches", async () => {
    await withPermissionFixture(async (cwd) => {
      setRuntimeKind("print");
      try {
        const call: ToolCall = {
          id: "t-hook-allow-headless",
          name: "Bash",
          input: { command: `touch ${bashPath(join(cwd, "..", "outside-headless.txt"))}` },
        };
        // Baseline: without a hook signal, this write escapes the workspace,
        // which forces the ask path -- headless has no UI to answer it, so it
        // auto-denies. This is the exact scenario from the finding: a
        // --print run with a PreToolUse hook that returns permissionDecision:
        // "allow" must still be able to create the file, not auto-deny it.
        expect(
          typeof (await resolvePermission(resolutionDeps(cwd, "default"), call)) === "object",
        ).toBe(true);

        const decision = await runWithPreToolUseHookPermissionSignal("allow", () =>
          resolvePermission(resolutionDeps(cwd, "default"), call),
        );
        expect(decision).toBe("allow");
      } finally {
        setRuntimeKind(null);
      }
    });
  });

  it("bypasses a genuinely detached background subagent's auto-deny on an explicit hook allow", async () => {
    await withPermissionFixture(async (cwd) => {
      const call: ToolCall = {
        id: "t-hook-allow-background",
        name: "Bash",
        input: { command: `rm ${bashPath(join(cwd, "..", "outside-background.txt"))}` },
      };
      const context = { ...forkContext(), shouldAvoidPermissionPrompts: true };

      const decision = await withSpawnedAgentScope(context, () =>
        runWithPreToolUseHookPermissionSignal("allow", () =>
          resolvePermission(resolutionDeps(cwd, "default"), call),
        ),
      );

      expect(decision).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps an explicit deny rule ahead of a hook allow (deny precedence is not bypassed)", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Bash" } }],
        cwd,
      );
      const decision = await runWithPreToolUseHookPermissionSignal("allow", () =>
        resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-hook-allow-explicit-deny",
          name: "Bash",
          input: { command: "echo hi" },
        }),
      );
      expect(decision).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps an explicit ask rule ahead of a hook allow (ask-rule precedence is not bypassed)", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "Bash" } }],
        cwd,
      );
      const decisionPromise = runWithPreToolUseHookPermissionSignal("allow", () =>
        resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-hook-allow-explicit-ask-rule",
          name: "Bash",
          input: { command: "echo hi" },
        }),
      );
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("Bash");
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(USER_REJECTED);
    });
  });

  it("forces the interactive prompt on an explicit hook ask even in yolo mode", async () => {
    await withPermissionFixture(async (cwd) => {
      const call: ToolCall = {
        id: "t-hook-ask-yolo",
        name: "Bash",
        input: { command: "echo hi" },
      };
      // Baseline: yolo auto-allows a plain, workspace-safe command with no
      // hook signal at all.
      expect(await resolvePermission(resolutionDeps(cwd, "yolo"), call)).toBe("allow");

      const decisionPromise = runWithPreToolUseHookPermissionSignal("ask", () =>
        resolvePermission(resolutionDeps(cwd, "yolo"), call),
      );
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("Bash");
      answerPermission(pending.id, { decision: "allow", updates: [] });
      expect(await decisionPromise).toBe("allow");
    });
  });

  it("forces the interactive prompt on an explicit hook ask even when an allow rule matches", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("echo *")], cwd);
      const call: ToolCall = {
        id: "t-hook-ask-allow-rule",
        name: "Bash",
        input: { command: "echo hi" },
      };
      // Baseline: the persisted allow rule auto-allows with no hook signal.
      expect(await resolvePermission(resolutionDeps(cwd, "default"), call)).toBe("allow");

      const decisionPromise = runWithPreToolUseHookPermissionSignal("ask", () =>
        resolvePermission(resolutionDeps(cwd, "default"), call),
      );
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(USER_REJECTED);
    });
  });
});

function allowRule(content: string): PermissionRule {
  return {
    source: "localSettings",
    ruleBehavior: "allow",
    ruleValue: { toolName: "Bash", ruleContent: content },
  };
}

function probesFor(rules: PermissionRule[], sessionPatterns: string[] = []): CompoundBashProbes {
  const store = new RuleStore();
  store.addAll(rules);
  return {
    matchSub: (sub) => store.match("Bash", sub),
    subSessionAllowed: (sub) =>
      sessionPatterns.some((pattern) => permissionPatternMatches(pattern, "Bash", sub)),
    subAutoAllowed: (sub) => isReadOnlyBashCommand(sub),
  };
}

describe("compoundBashDecision", () => {
  it("allows a saved prefix rule to cover the compound command that minted it", () => {
    const probes = probesFor([allowRule("sleep *")]);
    expect(compoundBashDecision("sleep 8 && echo MARKER_A", probes)).toBe("allow");
  });

  it("allows the next compound command after the rule is saved (live repro)", () => {
    const probes = probesFor([allowRule("sleep *")]);
    expect(compoundBashDecision("sleep 6 && echo step-1", probes)).toBe("allow");
  });

  it("keeps prompting when a segment is neither allowed nor read-only", () => {
    const probes = probesFor([allowRule("sleep *")]);
    expect(compoundBashDecision("sleep 1 && rm -rf /", probes)).toBeNull();
  });

  it("denies the whole command when any segment matches a deny rule", () => {
    const deny: PermissionRule = {
      source: "localSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Bash", ruleContent: "rm *" },
    };
    const probes = probesFor([allowRule("sleep *"), deny]);
    expect(compoundBashDecision("sleep 1 && rm -rf /tmp/x", probes)).toBe("deny");
  });

  it("forces the prompt when a segment matches an explicit ask rule", () => {
    const ask: PermissionRule = {
      source: "localSettings",
      ruleBehavior: "ask",
      ruleValue: { toolName: "Bash", ruleContent: "echo *" },
    };
    const probes = probesFor([allowRule("sleep *"), ask]);
    expect(compoundBashDecision("sleep 1 && echo hi", probes)).toBe("rule-ask");
  });

  it("never auto-allows a read-only segment that redirects output", () => {
    const probes = probesFor([allowRule("sleep *")]);
    expect(compoundBashDecision("sleep 1 && echo pwned > /etc/hosts", probes)).toBeNull();
  });

  it("refuses to split commands with substitution or newlines", () => {
    const probes = probesFor([allowRule("sleep *"), allowRule("echo *")]);
    expect(compoundBashDecision("sleep 1 && echo $(whoami)", probes)).toBeNull();
    expect(compoundBashDecision("sleep 1 &&\necho hi", probes)).toBeNull();
  });

  it("returns null for single commands (normal path decides)", () => {
    const probes = probesFor([allowRule("sleep *")]);
    expect(compoundBashDecision("sleep 5", probes)).toBeNull();
  });

  it("honors session grants for individual segments", () => {
    const probes = probesFor([], ["Bash(sleep *)", "Bash(bun test *)"]);
    expect(compoundBashDecision("sleep 2 && bun test src", probes)).toBe("allow");
  });

  it("splits on the background operator and judges each segment", () => {
    const probes = probesFor([allowRule("echo *")]);
    expect(compoundBashDecision("echo hello & rm -rf /tmp/x", probes)).toBeNull();
    expect(
      compoundBashDecision(
        "sleep 5 & echo done",
        probesFor([allowRule("sleep *"), allowRule("echo *")]),
      ),
    ).toBe("allow");
  });

  it("asks when compound fanout exceeds the security cap", () => {
    const command = Array.from({ length: 51 }, (_, i) => `echo ${i}`).join(" && ");
    expect(compoundBashDecision(command, probesFor([allowRule("echo *")]))).toBe("ask");
  });

  it("asks for multiple directory changes and directory-change plus git compounds", () => {
    const allowAll: CompoundBashProbes = {
      matchSub: () => "allow",
      subSessionAllowed: () => false,
      subAutoAllowed: () => false,
    };
    expect(compoundBashDecision("cd one && cd two", allowAll)).toBe("ask");
    expect(compoundBashDecision("cd repo && git status", allowAll)).toBe("ask");
  });

  it("denies a backgrounded segment matching a deny rule", () => {
    const deny: PermissionRule = {
      source: "localSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Bash", ruleContent: "rm *" },
    };
    const probes = probesFor([allowRule("echo *"), deny]);
    expect(compoundBashDecision("echo hi & rm -rf /tmp/x", probes)).toBe("deny");
  });
});

describe("cancelled permission prompts", () => {
  it("cancels a queued outside Write and rejects a stale approval before execution", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      const controller = new AbortController();
      const writes: string[] = [];
      const write: ScopedToolHandler = {
        schema: {
          name: "Write",
          description: "test write",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              content: { type: "string" },
            },
            required: ["file_path", "content"],
          },
        },
        run: async (call) => {
          writes.push((call.input as { content: string }).content);
          return { tool_use_id: call.id, content: "wrote" };
        },
      };
      const ctx: RequestContext = {
        provider: "anthropic",
        model: "test",
        effort: null,
        permissionMode: "yolo",
        sessionId: "permission-resolution-session",
        cwd,
        abortSignal: controller.signal,
        scopedToolHandlers: new Map([["Write", write]]),
      };
      const call: ToolCall = {
        id: "t-cancelled-outside-write",
        name: "Write",
        input: { file_path: join(dirname(cwd), "stale.txt"), content: "must not write" },
      };
      const result = dispatchTool(call, ctx, {
        permission: (candidate) => resolvePermission(resolutionDeps(cwd, "yolo"), candidate),
        hooks: [],
      });

      const pending = await waitForPermission();
      controller.abort();

      expect(answerPermission(pending.id, PermissionResults.allow())).toBe(false);
      expect(await result).toEqual({
        tool_use_id: call.id,
        content: "permission denied",
        is_error: true,
      });
      expect(writes).toEqual([]);

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      expect(await resolvePermission(resolutionDeps(cwd, "yolo"), call)).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });
});

describe("mode and rule resolution", () => {
  it("keeps internal control tools permission-free in default mode", async () => {
    await withPermissionFixture(async (cwd) => {
      for (const name of [
        "StructuredOutput",
        "SendMessage",
        "WaitForMcpServers",
        "ScheduleWakeup",
      ]) {
        expect(
          await resolvePermission(resolutionDeps(cwd, "default"), {
            id: `t-control-${name}`,
            name,
            input: {},
          }),
        ).toBe("allow");
      }
    });
  });

  it("allows ReadMcpResourceDirTool in default mode without a prompt (MCP-002)", async () => {
    await withPermissionFixture(async (cwd) => {
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-read-mcp-resource-dir",
          name: "ReadMcpResourceDirTool",
          input: { server: "docs", uri: "docs://guides" },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps explicit deny and ask rules ahead of the ReadMcpResourceDirTool permission-free default (MCP-002)", async () => {
    await withPermissionFixture(async (cwd) => {
      const toolName = "ReadMcpResourceDirTool";
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName } }],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-read-mcp-resource-dir-deny",
          name: toolName,
          input: { server: "docs", uri: "docs://guides" },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName } }],
        cwd,
      );
      const decisionPromise = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-read-mcp-resource-dir-ask",
        name: toolName,
        input: { server: "docs", uri: "docs://guides" },
      });
      const pending = await waitForPermission();
      expect(pending.toolName).toBe(toolName);
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(USER_REJECTED);
    });
  });

  it("allows dynamic MCP authenticate/complete_authentication tools in default mode without a prompt (MCP-003)", async () => {
    await withPermissionFixture(async (cwd) => {
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-mcp-authenticate",
          name: "mcp__github__authenticate",
          input: {},
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();

      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-mcp-complete-auth",
          name: "mcp__github__complete_authentication",
          input: { callback_url: "http://localhost:1234/callback?code=abc&state=def" },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps explicit deny and ask rules ahead of the dynamic MCP auth tool permission-free default (MCP-003)", async () => {
    await withPermissionFixture(async (cwd) => {
      const toolName = "mcp__github__authenticate";
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName } }],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-mcp-authenticate-deny",
          name: toolName,
          input: {},
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName } }],
        cwd,
      );
      const decisionPromise = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-mcp-authenticate-ask",
        name: toolName,
        input: {},
      });
      const pending = await waitForPermission();
      expect(pending.toolName).toBe(toolName);
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual(USER_REJECTED);
    });
  });

  it("applies configured rules before ordinary permission-free defaults", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Agent" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-denied-agent",
          name: "Agent",
          input: {},
        }),
      ).toBe("deny");
    });
  });

  it("denies a field-specific rule matched against its named input field, not the primary target", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Agent", ruleContent: "subagent_type:Explore" },
          },
        ],
        cwd,
      );
      // "description" wins as the primary target string ("x"), which the
      // deny pattern never matches — only reading the named `subagent_type`
      // field catches this call, ahead of Agent's permission-free default.
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-field-deny-agent",
          name: "Agent",
          input: { description: "x", prompt: "x", subagent_type: "Explore" },
        }),
      ).toBe("deny");

      // A different subagent_type is unaffected and stays permission-free.
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-field-deny-agent-other-type",
          name: "Agent",
          input: { description: "x", prompt: "x", subagent_type: "General" },
        }),
      ).toBe("allow");
    });
  });

  it("asks on a field-specific rule ahead of yolo, while yolo still allows non-matching fields", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Agent", ruleContent: "subagent_type:Explore" },
          },
        ],
        cwd,
      );
      const asked = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-field-ask-agent",
        name: "Agent",
        input: { description: "x", prompt: "x", subagent_type: "Explore" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, PermissionResults.deny());
      expect(await asked).toEqual(USER_REJECTED);

      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-field-ask-agent-other-type",
          name: "Agent",
          input: { description: "x", prompt: "x", subagent_type: "General" },
        }),
      ).toBe("allow");
    });
  });

  it("launches a workflow without a prompt unless an explicit rule says otherwise", async () => {
    await withPermissionFixture(async (cwd) => {
      const workflow = (id: string, input: Record<string, unknown>): ToolCall => ({
        id,
        name: "Workflow",
        input,
      });
      const named = { name: "harmless-probe" };
      const inline = { script: "export const meta = { name: 'inline-probe' }" };

      for (const mode of ["default", "accept-edits"] as const) {
        expect(
          await resolvePermission(resolutionDeps(cwd, mode), workflow(`t-workflow-${mode}`, named)),
        ).toBe("allow");
        expect(
          await resolvePermission(
            resolutionDeps(cwd, mode),
            workflow(`t-workflow-inline-${mode}`, inline),
          ),
        ).toBe("allow");
      }
      expect(
        await withSpawnedAgentScope({ ...forkContext(), shouldAvoidPermissionPrompts: true }, () =>
          resolvePermission(
            resolutionDeps(cwd, "default"),
            workflow("t-workflow-background", named),
          ),
        ),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Workflow" } }],
        cwd,
      );
      expect(
        await resolvePermission(
          resolutionDeps(cwd, "yolo"),
          workflow("t-workflow-whole-deny", named),
        ),
      ).toBe("deny");

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Workflow", ruleContent: "harmless-probe" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(
          resolutionDeps(cwd, "default"),
          workflow("t-workflow-name-deny", named),
        ),
      ).toBe("deny");

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Workflow", ruleContent: "harmless-probe" },
          },
        ],
        cwd,
      );
      const asked = resolvePermission(
        resolutionDeps(cwd, "yolo"),
        workflow("t-workflow-rule-ask", named),
      );
      const askedPending = await waitForPermission();
      expect(askedPending.rule).toBe("Workflow(harmless-probe)");
      answerPermission(askedPending.id, PermissionResults.deny());
      expect(await asked).toEqual(USER_REJECTED);
    });
  });

  it("applies default, accept-edits, and yolo semantics in the resolver", async () => {
    await withPermissionFixture(async (cwd) => {
      const editCall = {
        id: "t-edit",
        name: "Write",
        input: { file_path: join(cwd, "safe.ts"), content: "safe" },
      };
      const defaultDecision = resolvePermission(resolutionDeps(cwd, "default"), editCall);
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await defaultDecision).toEqual(USER_REJECTED);

      expect(await resolvePermission(resolutionDeps(cwd, "accept-edits"), editCall)).toBe("allow");
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-yolo",
          name: "ProbeTool",
          input: {},
        }),
      ).toBe("allow");
    });
  });

  it("keeps accept-edits scoped to workspace files", async () => {
    await withPermissionFixture(async (cwd) => {
      const decision = resolvePermission(resolutionDeps(cwd, "accept-edits"), {
        id: "t-outside-edit",
        name: "Write",
        input: { file_path: join(cwd, "..", "outside.ts"), content: "outside" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("auto-allows accept-edits writes in an additional working directory only", async () => {
    await withPermissionFixture(async (cwd) => {
      const addedDir = join(cwd, "..", "shared");
      mkdirSync(addedDir);
      const deps = resolutionDeps(cwd, "accept-edits", new Set(), () => {}, new Set([addedDir]));

      expect(
        await resolvePermission(deps, {
          id: "t-added-dir-edit",
          name: "Write",
          input: { file_path: join(addedDir, "inside.ts"), content: "inside" },
        }),
      ).toBe("allow");

      const outside = resolvePermission(deps, {
        id: "t-beyond-added-dir",
        name: "Write",
        input: { file_path: join(cwd, "..", "elsewhere", "outside.ts"), content: "outside" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await outside).toEqual(USER_REJECTED);
    });
  });

  it("applies addDirectories updates to the live session", async () => {
    await withPermissionFixture(async (cwd) => {
      const addedDir = join(cwd, "..", "shared");
      mkdirSync(addedDir);
      const deps = resolutionDeps(cwd, "accept-edits");
      const first = resolvePermission(deps, {
        id: "t-add-dir-update",
        name: "Write",
        input: { file_path: join(addedDir, "first.ts"), content: "first" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, {
        decision: "allow",
        updates: [{ type: "addDirectories", dirs: [addedDir] }],
      });
      expect(await first).toBe("allow");
      expect(
        await resolvePermission(deps, {
          id: "t-added-dir-after-update",
          name: "Write",
          input: { file_path: join(addedDir, "second.ts"), content: "second" },
        }),
      ).toBe("allow");
    });
  });

  it("does not revoke an additional working directory after denied removeDirectories", async () => {
    await withPermissionFixture(async (cwd) => {
      const addedDir = join(cwd, "..", "shared");
      const otherDir = join(cwd, "..", "other");
      mkdirSync(addedDir);
      mkdirSync(otherDir);
      const additional = new Set([addedDir]);
      const deps = resolutionDeps(cwd, "accept-edits", new Set(), () => {}, additional);
      const updatePrompt = resolvePermission(deps, {
        id: "t-remove-dir-update",
        name: "Write",
        input: { file_path: join(otherDir, "trigger.ts"), content: "trigger" },
      });
      const firstPending = await waitForPermission();
      answerPermission(firstPending.id, {
        decision: "deny",
        updates: [{ type: "removeDirectories", dirs: [addedDir] }],
      });
      expect(await updatePrompt).toEqual(USER_REJECTED);
      expect(additional.has(addedDir)).toBe(true);

      expect(
        await resolvePermission(deps, {
          id: "t-retained-dir-edit",
          name: "Write",
          input: { file_path: join(addedDir, "after.ts"), content: "after" },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps an approved outside edit directory available for the session", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const outsideDir = join(cwd, "..", "shared");
      const first = resolvePermission(deps, {
        id: "t-outside-session-first",
        name: "Write",
        input: { file_path: join(outsideDir, "first.ts"), content: "first" },
      });
      const pending = await waitForPermission();
      expect(pending.editDirectory).toBe(outsideDir);
      answerPermission(pending.id, PermissionResults.allowSessionEdits(outsideDir));
      expect(await first).toBe("allow");
      expect(
        await resolvePermission(deps, {
          id: "t-outside-session-second",
          name: "Write",
          input: { file_path: join(outsideDir, "second.ts"), content: "second" },
        }),
      ).toBe("allow");
    });
  });

  it("grants an outside read directory for the session without bypassing ask or deny rules", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const outsideDir = join(cwd, "..", "other-project");
      mkdirSync(outsideDir);

      const first = resolvePermission(deps, {
        id: "t-outside-read-first",
        name: "Read",
        input: { file_path: join(outsideDir, "a.txt") },
      });
      const pending = await waitForPermission();
      const resolvedOutsideDir = realpathSync(outsideDir);
      expect(pending.suggestions).toEqual([
        {
          type: "addRules",
          destination: "session",
          rules: expect.arrayContaining([
            {
              source: "session",
              ruleBehavior: "allow",
              ruleValue: { toolName: "Read", ruleContent: directoryPathPattern(outsideDir) },
            },
            {
              source: "session",
              ruleBehavior: "allow",
              ruleValue: {
                toolName: "Read",
                ruleContent: directoryPathPattern(resolvedOutsideDir),
              },
            },
          ]),
        },
      ]);
      answerPermission(
        pending.id,
        PermissionResults.allowSession(pending.rule!, pending.suggestions),
      );
      expect(await first).toBe("allow");
      expect(sessionGrants).toEqual(
        new Set([
          serializeRuleValue({
            toolName: "Read",
            ruleContent: directoryPathPattern(outsideDir),
          }),
          serializeRuleValue({
            toolName: "Read",
            ruleContent: directoryPathPattern(resolvedOutsideDir),
          }),
        ]),
      );

      expect(
        await resolvePermission(deps, {
          id: "t-outside-read-second",
          name: "Read",
          input: { file_path: join(outsideDir, "b.txt") },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: {
              toolName: "Read",
              ruleContent: filePathPattern(join(outsideDir, "asked.txt")),
            },
          },
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: {
              toolName: "Read",
              ruleContent: filePathPattern(join(outsideDir, "denied.txt")),
            },
          },
        ],
        cwd,
      );
      const asked = resolvePermission(deps, {
        id: "t-outside-read-explicit-ask",
        name: "Read",
        input: { file_path: join(outsideDir, "asked.txt") },
      });
      const askedPending = await waitForPermission();
      answerPermission(askedPending.id, PermissionResults.deny());
      expect(await asked).toEqual(USER_REJECTED);
      expect(
        await resolvePermission(deps, {
          id: "t-outside-read-explicit-deny",
          name: "Read",
          input: { file_path: join(outsideDir, "denied.txt") },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("does not downgrade yolo when accepting a setMode accept-edits update", async () => {
    await withPermissionFixture(async (cwd) => {
      // yolo already bypasses non-rule sensitive-path prompts, so force a prompt
      // with an explicit ask rule and verify accept-edits cannot demote yolo.
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Write" },
          },
        ],
        cwd,
      );
      const dispatched: unknown[] = [];
      const decision = resolvePermission(
        resolutionDeps(cwd, "yolo", new Set(), (action) => dispatched.push(action)),
        {
          id: "t-yolo-session-edit",
          name: "Write",
          input: { file_path: join(cwd, "notes.txt"), content: "ok" },
        },
      );
      const pending = await waitForPermission();
      answerPermission(pending.id, {
        decision: "allow",
        updates: [{ type: "setMode", mode: "accept-edits" }],
      });
      expect(await decision).toBe("allow");
      expect(dispatched).toEqual([]);
    });
  });

  it("does not apply denied mode updates while explicit ask and deny rules stay authoritative", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          { source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "AskTool" } },
          { source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "DenyTool" } },
        ],
        cwd,
      );
      const dispatched: unknown[] = [];
      const deps = resolutionDeps(cwd, "default", new Set(), (action) => dispatched.push(action));
      const first = resolvePermission(deps, {
        id: "t-denied-mode-update",
        name: "AskTool",
        input: {},
      });
      const firstPending = await waitForPermission();
      answerPermission(firstPending.id, {
        decision: "deny",
        updates: [{ type: "setMode", mode: "yolo" }],
      });
      expect(await first).toEqual(USER_REJECTED);
      expect(dispatched).toEqual([]);

      const second = resolvePermission(deps, {
        id: "t-ask-after-denial",
        name: "AskTool",
        input: {},
      });
      const secondPending = await waitForPermission();
      answerPermission(secondPending.id, { decision: "deny", updates: [] });
      expect(await second).toEqual(USER_REJECTED);

      expect(
        await resolvePermission(deps, { id: "t-deny-after-denial", name: "DenyTool", input: {} }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("removes an existing localSettings ask rule via a removeRules update (PERM-UPDATE-REMOVE-005)", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          { source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "AskTool" } },
          { source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "DenyTool" } },
        ],
        cwd,
      );
      const deps = resolutionDeps(cwd, "default");

      const first = resolvePermission(deps, {
        id: "t-remove-rules-ask",
        name: "AskTool",
        input: {},
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, {
        decision: "allow",
        updates: [
          {
            type: "removeRules",
            source: "localSettings",
            rules: [
              { source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "AskTool" } },
            ],
          },
        ],
      });
      expect(await first).toBe("allow");

      // The rule is gone from the persisted localSettings collection, not
      // merely bypassed for this one call.
      const persisted = (await loadRules(cwd)).filter((rule) => rule.source === "localSettings");
      expect(persisted).toEqual([
        { source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "DenyTool" } },
      ]);

      // Explicit deny precedence for an untouched rule is unaffected by the
      // removal and still short-circuits without prompting.
      expect(
        await resolvePermission(deps, {
          id: "t-remove-rules-deny-intact",
          name: "DenyTool",
          input: {},
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("removes a content-specific session grant with escaped path characters", async () => {
    await withPermissionFixture(async (cwd) => {
      const outsideDir = join(cwd, "..", "removed (copy)");
      const filePath = join(outsideDir, "notes.txt");
      mkdirSync(outsideDir);
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);

      const first = resolvePermission(deps, {
        id: "t-content-session-grant",
        name: "Read",
        input: { file_path: filePath },
      });
      const firstPending = await waitForPermission();
      const [grantUpdate] = firstPending.suggestions ?? [];
      if (grantUpdate?.type !== "addRules") throw new Error("expected a session rule suggestion");
      answerPermission(
        firstPending.id,
        PermissionResults.allowSession(firstPending.rule!, [grantUpdate]),
      );
      expect(await first).toBe("allow");
      expect(sessionGrants.size).toBeGreaterThan(0);

      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "AskTool" } }],
        cwd,
      );
      const removal = resolvePermission(deps, {
        id: "t-remove-content-session-grant",
        name: "AskTool",
        input: {},
      });
      const removalPending = await waitForPermission();
      answerPermission(removalPending.id, {
        decision: "allow",
        updates: [
          {
            type: "removeRules",
            source: "session",
            rules: grantUpdate.rules,
          },
        ],
      });
      expect(await removal).toBe("allow");
      expect(sessionGrants).toEqual(new Set());

      const after = resolvePermission(deps, {
        id: "t-content-session-grant-after-remove",
        name: "Read",
        input: { file_path: filePath },
      });
      const afterPending = await waitForPermission();
      answerPermission(afterPending.id, PermissionResults.deny());
      expect(await after).toEqual(USER_REJECTED);
    });
  });

  it("removes a session allow grant via a removeRules update targeting session", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "ask", ruleValue: { toolName: "AskTool" } }],
        cwd,
      );
      const sessionGrants = new Set<string>(["AllowTool"]);
      const deps = resolutionDeps(cwd, "default", sessionGrants);

      // AllowTool is already granted for the session and needs no prompt.
      expect(
        await resolvePermission(deps, {
          id: "t-session-allow-before",
          name: "AllowTool",
          input: {},
        }),
      ).toBe("allow");

      // Trigger a prompt on an unrelated tool and answer it with a
      // removeRules update targeting the session grant made above.
      const decision = resolvePermission(deps, {
        id: "t-remove-session-rule",
        name: "AskTool",
        input: {},
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, {
        decision: "allow",
        updates: [
          {
            type: "removeRules",
            source: "session",
            rules: [
              { source: "session", ruleBehavior: "allow", ruleValue: { toolName: "AllowTool" } },
            ],
          },
        ],
      });
      expect(await decision).toBe("allow");
      expect(sessionGrants.has("AllowTool")).toBe(false);

      // With the grant gone, AllowTool now requires a fresh prompt.
      const after = resolvePermission(deps, {
        id: "t-session-allow-after",
        name: "AllowTool",
        input: {},
      });
      const afterPending = await waitForPermission();
      answerPermission(afterPending.id, { decision: "deny", updates: [] });
      expect(await after).toEqual(USER_REJECTED);
    });
  });

  it("keeps deny and ask rules ahead of session grants and permissive modes", async () => {
    await withPermissionFixture(async (cwd) => {
      const rules: PermissionRule[] = [
        {
          source: "localSettings",
          ruleBehavior: "deny",
          ruleValue: { toolName: "Write" },
        },
        {
          source: "localSettings",
          ruleBehavior: "ask",
          ruleValue: { toolName: "Bash", ruleContent: "npm publish *" },
        },
      ];
      await saveRules(rules, cwd);

      expect(
        await resolvePermission(resolutionDeps(cwd, "accept-edits", new Set(["Write"])), {
          id: "t-denied-edit",
          name: "Write",
          input: { file_path: join(cwd, "safe.ts"), content: "safe" },
        }),
      ).toBe("deny");

      const askDecision = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-asked-bash",
        name: "Bash",
        input: { command: "npm publish package.tgz" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await askDecision).toEqual(USER_REJECTED);
    });
  });

  it("prompts when an allow-ruled cp targets a sensitive basename", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("cp *")], cwd);
      const decision = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-sensitive-cp",
        name: "Bash",
        input: { command: `cp payload ${bashPath(join(cwd, ".bashrc"))}` },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("allows an allow-ruled cp between normal workspace paths", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("cp *")], cwd);
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-workspace-cp",
          name: "Bash",
          input: { command: "cp payload copied.txt" },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("prompts when an allow-ruled env-wrapped cp writes outside the workspace", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("env cp *")], cwd);
      const decision = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-env-outside-cp",
        name: "Bash",
        input: { command: "env cp payload /outside/copied.txt" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("fails closed for allow-ruled env options that alter or obscure argv", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("env *")], cwd);
      for (const command of [
        "env -S cp payload copied.txt",
        "env -C /tmp cp payload copied.txt",
        "env -P /tmp cp payload copied.txt",
        "env -u",
        "env --unknown cp payload copied.txt",
      ]) {
        const decision = resolvePermission(resolutionDeps(cwd, "default"), {
          id: `t-env-unparseable-${command}`,
          name: "Bash",
          input: { command },
        });
        const pending = await waitForPermission();
        answerPermission(pending.id, { decision: "deny", updates: [] });
        expect(await decision).toEqual(USER_REJECTED);
      }
    });
  });

  it("keeps explicit env-wrapped cp ask and deny rules ahead of allows and yolo", async () => {
    await withPermissionFixture(async (cwd) => {
      const ask: PermissionRule = {
        source: "localSettings",
        ruleBehavior: "ask",
        ruleValue: { toolName: "Bash", ruleContent: "env cp *" },
      };
      await saveRules([allowRule("env cp *"), ask], cwd);
      const asked = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-env-cp-rule-ask",
        name: "Bash",
        input: { command: "env cp payload copied.txt" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await asked).toEqual(USER_REJECTED);

      await saveRules(
        [
          allowRule("env cp *"),
          ask,
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: "env cp *" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-env-cp-rule-deny",
          name: "Bash",
          input: { command: "env cp payload copied.txt" },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("prompts for an allow-ruled compound cd plus write", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("cd *"), allowRule("mv *")], cwd);
      const decision = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-cd-mv",
        name: "Bash",
        input: { command: "cd x && mv a b" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("allows an allow-ruled read-only compound cd plus ls", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules([allowRule("cd *"), allowRule("ls")], cwd);
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-cd-ls",
          name: "Bash",
          input: { command: "cd x && ls" },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  // FS-002 regression: a separately allow-ruled `cd` and a separately
  // allow-ruled read command must not combine into a silent "allow" when the
  // cd destination itself leaves the workspace — the later relative operand
  // (`secret.txt`) is actually resolved against that outside directory at
  // runtime, not against the original cwd that path checks see.
  it("prompts for an allow-ruled compound cd that leaves the workspace before an allow-ruled cat", async () => {
    await withPermissionFixture(async (cwd) => {
      const outsideDir = dirname(cwd);
      await saveRules([allowRule("cd *"), allowRule("cat *")], cwd);
      const decision = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-cd-outside-cat",
        name: "Bash",
        input: { command: `cd ${bashPath(outsideDir)} && cat secret.txt` },
      });
      const pending = await waitForPermission();
      expect(pending.toolName).toBe("Bash");
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("still allows the same compound once the cd destination is added as a working directory", async () => {
    await withPermissionFixture(async (cwd) => {
      const outsideDir = dirname(cwd);
      await saveRules([allowRule("cd *"), allowRule("cat *")], cwd);
      expect(
        await resolvePermission(
          resolutionDeps(cwd, "default", new Set(), () => {}, new Set([outsideDir])),
          {
            id: "t-cd-outside-cat-allowed-dir",
            name: "Bash",
            input: { command: `cd ${bashPath(outsideDir)} && cat secret.txt` },
          },
        ),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  // An explicit deny rule on the `cd` segment itself must still short-circuit
  // straight to "deny" (no prompt at all) even though the new cd-destination
  // check would independently ask — explicit rule precedence is unaffected.
  it("keeps an explicit deny rule on the cd segment ahead of the new cd-destination ask", async () => {
    await withPermissionFixture(async (cwd) => {
      const outsideDir = dirname(cwd);
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: "cd *" },
          },
          allowRule("cat *"),
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "default"), {
          id: "t-cd-outside-cat-deny-rule",
          name: "Bash",
          input: { command: `cd ${bashPath(outsideDir)} && cat secret.txt` },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();
    });
  });

  it("prompts before auto-allowing read-only Bash paths outside working directories", async () => {
    await withPermissionFixture(async (cwd) => {
      for (const mode of ["default", "accept-edits"] as const) {
        for (const command of ["cat /etc/passwd", "ls /etc"]) {
          const decision = resolvePermission(resolutionDeps(cwd, mode), {
            id: `t-outside-read-${mode}-${command}`,
            name: "Bash",
            input: { command },
          });
          const pending = await waitForPermission();
          expect(pending.toolName).toBe("Bash");
          answerPermission(pending.id, { decision: "deny", updates: [] });
          expect(await decision).toEqual(USER_REJECTED);
        }
      }
    });
  });

  it("keeps explicit Bash ask and deny rules ahead of read-path and yolo allowances", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: "cat /etc/passwd" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-outside-read-deny",
          name: "Bash",
          input: { command: "cat /etc/passwd" },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Bash", ruleContent: "ls /etc" },
          },
        ],
        cwd,
      );
      const asked = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-outside-read-ask",
        name: "Bash",
        input: { command: "ls /etc" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await asked).toEqual(USER_REJECTED);
    });
  });

  it("lets yolo override conservative compound heuristics", async () => {
    await withPermissionFixture(async (cwd) => {
      const command = Array.from({ length: 51 }, (_, i) => `echo ${i}`).join(" && ");
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-yolo-compound-cap",
          name: "Bash",
          input: { command },
        }),
      ).toBe("allow");
    });
  });

  it("lets yolo bypass non-rule path safety prompts", async () => {
    await withPermissionFixture(async (cwd) => {
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-outside-read-yolo",
          name: "Bash",
          input: { command: "cat /etc/passwd" },
        }),
      ).toBe("allow");
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-sensitive-write",
          name: "Write",
          input: { file_path: join(cwd, ".env"), content: "SECRET=value" },
        }),
      ).toBe("allow");
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-sensitive-bash",
          name: "Bash",
          input: { command: `rm ${bashPath(join(dirname(cwd), ".bashrc"))}` },
        }),
      ).toBe("allow");
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-memory-bash",
          name: "Bash",
          input: { command: `rm ${bashPath(join(autoMemDir(cwd), "topic.md"))}` },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });

  it("checks canonical Edit deny and ask rules before yolo for symlink targets", async () => {
    await withPermissionFixture(async (cwd) => {
      const targetDir = join(dirname(cwd), "canonical-target");
      const targetFile = join(targetDir, "target.txt");
      const link = join(cwd, "canonical-link");
      const linkedFile = join(link, "target.txt");
      mkdirSync(targetDir);
      symlinkSync(targetDir, link, "dir");
      const call = {
        name: "Edit",
        input: { file_path: linkedFile, old_string: "x", new_string: "y" },
      };

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Edit", ruleContent: filePathPattern(targetFile) },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), { id: "t-symlink-deny", ...call }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Edit", ruleContent: filePathPattern(linkedFile) },
          },
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Edit", ruleContent: filePathPattern(targetFile) },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-symlink-deny-before-ask",
          ...call,
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: "Edit", ruleContent: filePathPattern(targetFile) },
          },
        ],
        cwd,
      );
      const askDecision = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-symlink-ask",
        ...call,
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await askDecision).toEqual(USER_REJECTED);
    });
  });

  it("prompts for accept-edits Write and Bash writes through a symlink into a sensitive directory", async () => {
    await withPermissionFixture(async (cwd) => {
      const gitDir = join(cwd, ".git");
      mkdirSync(gitDir);
      const alias = join(cwd, "alias");
      symlinkSync(gitDir, alias, "dir");
      const deps = resolutionDeps(cwd, "accept-edits");

      const writeDecision = resolvePermission(deps, {
        id: "t-symlink-sensitive-write",
        name: "Write",
        input: { file_path: join(alias, "config"), content: "x" },
      });
      const writePending = await waitForPermission();
      answerPermission(writePending.id, { decision: "deny", updates: [] });
      expect(await writeDecision).toEqual(USER_REJECTED);

      const bashDecision = resolvePermission(deps, {
        id: "t-symlink-sensitive-bash",
        name: "Bash",
        input: { command: `touch ${bashPath(join(alias, "config"))}` },
      });
      const bashPending = await waitForPermission();
      answerPermission(bashPending.id, { decision: "deny", updates: [] });
      expect(await bashDecision).toEqual(USER_REJECTED);
    });
  });

  it("does not let an allow-ruled Bash write bypass a symlink into a sensitive directory", async () => {
    await withPermissionFixture(async (cwd) => {
      const gitDir = join(cwd, ".git");
      mkdirSync(gitDir);
      const alias = join(cwd, "alias");
      symlinkSync(gitDir, alias, "dir");
      await saveRules([allowRule("touch *")], cwd);

      const decision = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-symlink-allow-rule-bash",
        name: "Bash",
        input: { command: `touch ${bashPath(join(alias, "config"))}` },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("persists and reloads allow, deny, and ask rules", async () => {
    await withPermissionFixture(async (cwd) => {
      const behaviors: PermissionBehavior[] = ["allow", "deny", "ask"];
      const rules = behaviors.map(
        (ruleBehavior): PermissionRule => ({
          source: "localSettings",
          ruleBehavior,
          ruleValue: { toolName: "Bash", ruleContent: `${ruleBehavior} *` },
        }),
      );
      await saveRules(rules, cwd);
      const loaded = await loadRules(cwd);
      expect(
        loaded
          .filter((rule) => rule.source === "localSettings")
          .map((rule) => [rule.ruleBehavior, rule.ruleValue.ruleContent]),
      ).toEqual([
        ["allow", "allow *"],
        ["ask", "ask *"],
        ["deny", "deny *"],
      ]);
    });
  });

  it("matches rules against full input instead of the truncated display preview", async () => {
    await withPermissionFixture(async (cwd) => {
      const command = `deploy ${"x".repeat(220)} blocked`;
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: command },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-long-rule",
          name: "Bash",
          input: { command },
        }),
      ).toBe("deny");
    });
  });

  it("applies session grants in memory without persisting them", async () => {
    await withPermissionFixture(async (cwd) => {
      const sessionGrants = new Set<string>();
      const deps = resolutionDeps(cwd, "default", sessionGrants);
      const firstDecision = resolvePermission(deps, {
        id: "t-session-grant",
        name: "Bash",
        input: { command: "deploy package focused" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, PermissionResults.allowSession("Bash(deploy package *)"));
      expect(await firstDecision).toBe("allow");
      expect(sessionGrants).toEqual(new Set(["Bash(deploy package *)"]));
      expect(
        await resolvePermission(deps, {
          id: "t-session-grant-reuse",
          name: "Bash",
          input: { command: "deploy package another" },
        }),
      ).toBe("allow");
      expect((await loadRules(cwd)).filter((rule) => rule.source === "localSettings")).toEqual([]);
    });
  });

  it("does not widen Bash grants through execution-affecting environment variables", async () => {
    await withPermissionFixture(async (cwd) => {
      const decision = resolvePermission(resolutionDeps(cwd, "default", new Set(["Bash:node *"])), {
        id: "t-session-env",
        name: "Bash",
        input: { command: "NODE_OPTIONS=--require=/tmp/payload.js node app.js" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decision).toEqual(USER_REJECTED);
    });
  });

  it("checks every compound Bash segment before yolo", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: "rm *" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-compound-deny",
          name: "Bash",
          input: { command: "echo safe && rm -rf /tmp/permission-test" },
        }),
      ).toBe("deny");
    });
  });

  it("keeps the dangerous rm/rmdir root-variable-expansion safety check bypass-immune in yolo (YOLO-DANGEROUS-RM-001)", async () => {
    await withPermissionFixture(async (cwd) => {
      // `rm -rf $UNSET/*` expands to `rm -rf /*` at runtime when $UNSET is
      // unset or empty. Yolo must still surface an explicit ask for this
      // narrow pattern instead of auto-allowing it.
      const asked = resolvePermission(resolutionDeps(cwd, "yolo"), {
        id: "t-dangerous-rm-root-var-yolo",
        name: "Bash",
        input: { command: "rm -rf $UNSET/*" },
      });
      const pending = await waitForPermission();
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await asked).toEqual(USER_REJECTED);

      // Quoted, braced, rmdir, and compound variants of the same pattern
      // must also stay bypass-immune (answered "allow" here just to prove
      // each one reaches the ask instead of being silently auto-allowed).
      for (const command of [
        'rm -rf "$UNSET"/',
        'rm -rf "${VAR}"/*',
        "rmdir $UNSET/",
        "echo hi && rm -rf $UNSET/*",
      ]) {
        const nextAsk = resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: `t-dangerous-rm-root-var-yolo-${command}`,
          name: "Bash",
          input: { command },
        });
        const nextPending = await waitForPermission();
        answerPermission(nextPending.id, { decision: "allow", updates: [] });
        expect(await nextAsk).toBe("allow");
      }

      // An explicit deny rule on the same command still wins outright —
      // this fix must not weaken existing deny precedence.
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: "rm -rf $UNSET/*" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-dangerous-rm-root-var-deny-rule",
          name: "Bash",
          input: { command: "rm -rf $UNSET/*" },
        }),
      ).toBe("deny");

      // Narrow scope: a non-rm write through an unresolved variable (e.g.
      // mkdir) is untouched by this fix and keeps bypassing in yolo exactly
      // as before, via the existing mode-gated path check.
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-non-rm-var-write-yolo",
          name: "Bash",
          input: { command: "mkdir $SOME_DIR/sub" },
        }),
      ).toBe("allow");

      // Narrow scope: an ordinary rm outside the workspace that does not
      // match the root-variable-expansion pattern still bypasses in yolo —
      // the previously confirmed yolo baseline is unaffected.
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-plain-rm-outside-yolo",
          name: "Bash",
          input: { command: `rm ${bashPath(join(dirname(cwd), ".bashrc"))}` },
        }),
      ).toBe("allow");

      expect(peekPermission()).toBeNull();
    });
  });

  it("keeps catastrophic rm/rmdir targets (root, home, OS-critical dirs, workspace ancestors) bypass-immune in yolo (F1)", async () => {
    await withPermissionFixture(async (rootCwd) => {
      // Nest the actual session cwd one level under the fixture's project
      // dir so the parent itself is a genuine workspace-ancestor target.
      const cwd = join(rootCwd, "sub");
      mkdirSync(cwd, { recursive: true });
      const fsRoot = parse(cwd).root;

      // Filesystem root, home directory, a direct child of root, the cwd's
      // own ancestor, and the cwd itself: none of these may be silently
      // allowed in yolo.
      for (const command of [
        "rm -rf /",
        "rm -rf ~",
        `rm -rf ${bashPath(join(fsRoot, "usr"))}`,
        `rmdir ${bashPath(rootCwd)}`,
        "rm -rf .",
      ]) {
        const asked = resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: `t-catastrophic-rm-yolo-${command}`,
          name: "Bash",
          input: { command },
        });
        const pending = await waitForPermission();
        expect(pending.toolName).toBe("Bash");
        answerPermission(pending.id, { decision: "deny", updates: [] });
        expect(await asked).toEqual(USER_REJECTED);
      }

      // Same scenario reproduces in default mode when a benign Bash(rm *)
      // allow rule is present — the ask must run ahead of the allow rule,
      // not just ahead of yolo/accept-edits.
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "allow",
            ruleValue: { toolName: "Bash", ruleContent: "rm *" },
          },
        ],
        cwd,
      );
      const askedWithAllowRule = resolvePermission(resolutionDeps(cwd, "default"), {
        id: "t-catastrophic-rm-allow-rule",
        name: "Bash",
        input: { command: "rm -rf /" },
      });
      const pendingWithAllowRule = await waitForPermission();
      answerPermission(pendingWithAllowRule.id, { decision: "deny", updates: [] });
      expect(await askedWithAllowRule).toEqual(USER_REJECTED);

      // An explicit deny rule on the same command still wins outright, with
      // no prompt at all — this fix must not weaken existing deny precedence.
      await saveRules(
        [
          {
            source: "localSettings",
            ruleBehavior: "allow",
            ruleValue: { toolName: "Bash", ruleContent: "rm *" },
          },
          {
            source: "localSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: "Bash", ruleContent: "rm -rf /" },
          },
        ],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-catastrophic-rm-deny-rule",
          name: "Bash",
          input: { command: "rm -rf /" },
        }),
      ).toBe("deny");
      expect(peekPermission()).toBeNull();

      // Narrow scope: an rm target that is neither a critical system dir nor
      // an ancestor of any tracked working directory still bypasses in
      // yolo — a sibling file next to (not an ancestor of) cwd is untouched.
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-plain-rm-sibling-yolo",
          name: "Bash",
          input: { command: `rm ${bashPath(join(rootCwd, "sibling-file.txt"))}` },
        }),
      ).toBe("allow");
      expect(peekPermission()).toBeNull();
    });
  });
});

describe("permission feedback delivery", () => {
  function feedbackDeps(injected: string[]): PermissionResolutionDeps {
    return {
      injections: {
        push: (s: string) => injected.push(s),
        drain: () => injected.splice(0),
        peek: () => injected,
      },
      sessionAllowedToolPatterns: new Set<string>(),
      agentDeps: {
        broker: { read: () => ({ permissionMode: "default" }) },
        session: { id: "feedback-test-session", cwd: "/nonexistent-feedback-test" },
        config: {},
      },
    } as unknown as PermissionResolutionDeps;
  }

  async function waitForPending(): Promise<PendingPermission> {
    for (let i = 0; i < 100; i += 1) {
      const pending = peekPermission();
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("permission ask never surfaced");
  }

  it("routes approval feedback into the injection queue", async () => {
    const injected: string[] = [];
    const decisionPromise = resolvePermission(feedbackDeps(injected), {
      id: "t-allow",
      name: "ProbeTool",
      input: {},
    });
    const pending = await waitForPending();
    try {
      answerPermission(pending.id, {
        decision: "allow",
        updates: [],
        feedback: "prefer rg over grep",
      });
      expect(await decisionPromise).toBe("allow");
      expect(injected).toEqual(["[user-feedback-on-tool-approval]\nprefer rg over grep"]);
    } finally {
      clearPermissionQueue();
    }
  });

  it("carries rejection directions on the denial the model sees, without ending the turn", async () => {
    const injected: string[] = [];
    const decisionPromise = resolvePermission(feedbackDeps(injected), {
      id: "t-deny",
      name: "ProbeTool",
      input: {},
    });
    const pending = await waitForPending();
    try {
      answerPermission(pending.id, {
        decision: "deny",
        updates: [],
        feedback: "<directions>",
      });
      const decision = await decisionPromise;
      expect(decision).toEqual({
        kind: "deny",
        message: `${USER_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`,
      });
      expect(injected).toEqual([]);
    } finally {
      clearPermissionQueue();
    }
  });

  it("stops the turn when the user rejects without directions", async () => {
    const injected: string[] = [];
    const decisionPromise = resolvePermission(feedbackDeps(injected), {
      id: "t-deny-plain",
      name: "ProbeTool",
      input: {},
    });
    const pending = await waitForPending();
    try {
      answerPermission(pending.id, { decision: "deny", updates: [] });
      expect(await decisionPromise).toEqual({
        kind: "deny",
        message: USER_REJECTED_TOOL_RESULT,
        stopsTurn: true,
      });
      expect(injected).toEqual([]);
    } finally {
      clearPermissionQueue();
    }
  });

  it("lets an agent whose call the user rejected look for another way", async () => {
    for (const [feedback, message] of [
      [undefined, AGENT_TOOL_REJECTED_RESULT],
      ["<directions>", `${AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`],
    ] as const) {
      const decisionPromise = withSpawnedAgentScope(forkContext(), () =>
        resolvePermission(feedbackDeps([]), { id: "t-agent-deny", name: "ProbeTool", input: {} }),
      );
      const pending = await waitForPending();
      try {
        answerPermission(pending.id, {
          decision: "deny",
          updates: [],
          ...(feedback ? { feedback } : {}),
        });
        expect(await decisionPromise).toEqual({ kind: "deny", message });
      } finally {
        clearPermissionQueue();
      }
    }
  });
});

describe("auto-memory directory writes", () => {
  it("auto-allows memory-file edits in default, accept-edits, and yolo", async () => {
    await withPermissionFixture(async (cwd) => {
      const memFile = join(autoMemDir(cwd), "topic.md");
      for (const mode of ["default", "accept-edits", "yolo"] as const) {
        expect(
          await resolvePermission(resolutionDeps(cwd, mode), {
            id: `t-mem-${mode}`,
            name: "Write",
            input: { file_path: memFile, content: "note" },
          }),
        ).toBe("allow");
      }
      expect(peekPermission()).toBeNull();
    });
  });

  it("still lets an explicit deny rule block a memory edit", async () => {
    await withPermissionFixture(async (cwd) => {
      await saveRules(
        [{ source: "localSettings", ruleBehavior: "deny", ruleValue: { toolName: "Write" } }],
        cwd,
      );
      expect(
        await resolvePermission(resolutionDeps(cwd, "yolo"), {
          id: "t-mem-deny",
          name: "Write",
          input: { file_path: join(autoMemDir(cwd), "MEMORY.md"), content: "x" },
        }),
      ).toBe("deny");
    });
  });
});
