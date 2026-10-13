import { afterEach, describe, expect, it } from "bun:test";
import {
  ask,
  clear as clearPermissionQueue,
  type PermissionResult,
  peek,
} from "@/kernel/channels/permission.ts";
import type { Session } from "@/kernel/std/types/session.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { applyIncomingEvent } from "../rails/durable.ts";

const session = { id: "session-1", records: [] } as unknown as Session;
const broker = { dispatch: () => {} } as unknown as Broker;

afterEach(() => {
  // Resolve any prompts a failing test left behind so promises do not leak.
  clearPermissionQueue();
});

// ask() resolves synchronously when answered; a settled marker lets tests
// assert both resolution and continued pendingness without hanging.
function track(promise: Promise<PermissionResult>): {
  settled: () => boolean;
  value: () => PermissionResult;
} {
  let done = false;
  let result: PermissionResult | undefined;
  promise.then((r) => {
    done = true;
    result = r;
  });
  return {
    settled: () => done,
    value: () => {
      if (result === undefined) throw new Error("prompt not resolved");
      return result;
    },
  };
}

function raisePrompt(overrides: { toolName?: string; rule?: string | null } = {}): {
  tracked: ReturnType<typeof track>;
  id: string;
} {
  const tracked = track(
    ask({
      toolName: overrides.toolName ?? "Bash",
      argsPreview: "rm -rf /tmp/x",
      rule: overrides.rule === undefined ? "Bash(rm *)" : overrides.rule,
    }),
  );
  const id = peek()?.id;
  if (!id) throw new Error("no pending prompt");
  return { tracked, id };
}

function respond(id: string, response: string, extra: Record<string, unknown> = {}): void {
  applyIncomingEvent({
    eventType: "permission_response",
    parsed: { id, response, ...extra },
    session,
    broker,
  });
}

describe("remote permission_response through durable events", () => {
  it("allow_always persists the CLI-computed rule, ignoring the companion's rule", async () => {
    const { tracked, id } = raisePrompt({ rule: "Bash(rm *)" });

    respond(id, "allow_always", { rule: "Bash(*)" });
    await Bun.sleep(0);

    expect(tracked.settled()).toBe(true);
    const result = tracked.value();
    expect(result.decision).toBe("allow");
    expect(result.updates).toEqual([
      {
        type: "addRules",
        destination: "localSettings",
        rules: [
          {
            source: "localSettings",
            ruleBehavior: "allow",
            ruleValue: { toolName: "Bash", ruleContent: "rm *" },
          },
        ],
      },
    ]);
  });

  it("allow_always persists every rule the CLI computed for a compound command", async () => {
    const tracked = track(
      ask({
        toolName: "Bash",
        argsPreview: "cargo build && make check",
        rule: null,
        rules: ["Bash(cargo build *)", "Bash(make check *)"],
      }),
    );
    const id = peek()?.id;
    if (!id) throw new Error("no pending prompt");

    respond(id, "allow_always", { rule: "Bash(*)" });
    await Bun.sleep(0);

    const [update] = tracked.value().updates;
    expect(update?.type === "addRules" ? update.rules.map((rule) => rule.ruleValue) : []).toEqual([
      { toolName: "Bash", ruleContent: "cargo build *" },
      { toolName: "Bash", ruleContent: "make check *" },
    ]);
  });

  it("allow_always without a CLI rule downgrades to a one-shot allow", async () => {
    const { tracked, id } = raisePrompt({ rule: null });

    respond(id, "allow_always", { rule: "Bash(*)" });
    await Bun.sleep(0);

    expect(tracked.value()).toEqual({ decision: "allow", updates: [] });
  });

  it("ignores a retired mode-escalation answer and keeps the prompt up", async () => {
    for (const response of ["plan_bypass", "plan_accept_edits", "plan_default", "plan_feedback"]) {
      const { tracked, id } = raisePrompt({ toolName: "Edit" });

      respond(id, response);
      await Bun.sleep(0);

      expect(tracked.settled()).toBe(false);
      expect(peek()?.id).toBe(id);
      respond(id, "deny");
      await Bun.sleep(0);
    }
  });

  it("deny passes feedback through", async () => {
    const { tracked, id } = raisePrompt();

    respond(id, "deny", { feedback: "not on this host" });
    await Bun.sleep(0);

    expect(tracked.value()).toEqual({
      decision: "deny",
      updates: [],
      feedback: "not on this host",
    });
  });

  it("an unknown id leaves the prompt untouched", async () => {
    const { tracked, id } = raisePrompt();

    respond("perm_bogus_999", "allow_always", { rule: "Bash(*)" });
    await Bun.sleep(0);

    expect(tracked.settled()).toBe(false);
    expect(peek()?.id).toBe(id);
  });
});
