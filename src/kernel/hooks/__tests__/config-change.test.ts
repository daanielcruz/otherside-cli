import { describe, expect, test } from "bun:test";
import type { UserConfig } from "@/kernel/config/config.ts";
import { fireConfigChangeHooks } from "../config-change.ts";
import type { ConfigChangeCtx } from "../events.ts";

function configWith(command: string, matcher = "*"): UserConfig {
  return { hooks: { configChange: [{ matcher, command }] } } as UserConfig;
}

function change(over: Partial<ConfigChangeCtx> = {}): ConfigChangeCtx {
  return {
    source: "user_settings",
    filePath: "/config/settings.json",
    sessionId: "session-1",
    cwd: "/workspace",
    ...over,
  };
}

describe("what a ConfigChange hook can decide", () => {
  test("a hook that exits with the blocking code refuses the change", async () => {
    const { blocked } = await fireConfigChangeHooks(configWith("exit 2"), change());
    expect(blocked).toBe(true);
  });

  test("a hook that prints a block decision and exits 0 refuses it just as much", async () => {
    const command = `printf '%s' '{"decision":"block","reason":"pinned"}'`;
    const { blocked } = await fireConfigChangeHooks(configWith(command), change());
    expect(blocked).toBe(true);
  });

  test("a hook that simply runs lets the change through", async () => {
    const { outcomes, blocked } = await fireConfigChangeHooks(configWith("true"), change());
    expect(blocked).toBe(false);
    expect(outcomes).toHaveLength(1);
  });

  test("a hook that fails for its own reasons is not a refusal", async () => {
    // Only the blocking code speaks for the change; any other failure is the
    // hook's problem and leaves the change alone.
    const { blocked } = await fireConfigChangeHooks(configWith("exit 1"), change());
    expect(blocked).toBe(false);
  });

  test("no hook at all means nothing to refuse", async () => {
    const { outcomes, blocked } = await fireConfigChangeHooks({} as UserConfig, change());
    expect(outcomes).toHaveLength(0);
    expect(blocked).toBe(false);
  });
});

describe("which changes a hook is asked about", () => {
  test("the matcher names the scope, so a hook can watch one file and not the others", async () => {
    const config = configWith("exit 2", "project_settings");
    expect(
      (await fireConfigChangeHooks(config, change({ source: "project_settings" }))).blocked,
    ).toBe(true);
    expect(
      (await fireConfigChangeHooks(config, change({ source: "user_settings" }))).outcomes,
    ).toHaveLength(0);
  });

  test("managed policy runs its hooks for the record but cannot be refused", async () => {
    // Policy is administered rather than chosen: a session does not get to
    // decline it, though a hook still gets to see it happen.
    const { outcomes, blocked } = await fireConfigChangeHooks(
      configWith("exit 2"),
      change({ source: "policy_settings" }),
    );
    expect(outcomes).toHaveLength(1);
    expect(blocked).toBe(false);
  });
});
