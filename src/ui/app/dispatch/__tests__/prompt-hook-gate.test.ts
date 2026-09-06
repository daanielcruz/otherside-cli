import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import { createPromptHookGate } from "@/ui/app/dispatch/prompt-hook-gate.ts";

function makeRig(config: UserConfig) {
  let entries: readonly TranscriptEntry[] = [];
  const gate = createPromptHookGate({
    runtimeConfig: config,
    setTranscript: (write) => {
      entries = typeof write === "function" ? write(entries) : write;
    },
  });
  return { gate, transcript: () => entries };
}

const withHook = (command: string): UserConfig =>
  ({ hooks: { userPromptSubmit: [{ matcher: "", command }] } }) as UserConfig;

describe("prompt hook gate", () => {
  test("a blocking hook keeps the prompt from running and surfaces the reason", async () => {
    const { gate, transcript } = makeRig(withHook("echo 'nope' >&2; exit 2"));
    let ran = false;
    const dispatched = await gate("hello", async () => {
      ran = true;
    });
    expect(dispatched).toBe(false);
    expect(ran).toBe(false);
    const lines = transcript();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toStartWith("prompt blocked by hook:");
  });

  test("a passing hook hands its additional context to the turn", async () => {
    const { gate, transcript } = makeRig(
      withHook(`printf '%s' '{"additionalContext":"ctx-from-hook"}'`),
    );
    let seen: readonly string[] = [];
    const dispatched = await gate("hello", async (additionalContext) => {
      seen = additionalContext;
    });
    expect(dispatched).toBe(true);
    expect([...seen]).toEqual(["ctx-from-hook"]);
    expect(transcript()).toHaveLength(0);
  });

  test("no configured hooks leaves the path untouched", async () => {
    const { gate, transcript } = makeRig({} as UserConfig);
    let ran = false;
    const dispatched = await gate("hello", async () => {
      ran = true;
    });
    expect(dispatched).toBe(true);
    expect(ran).toBe(true);
    expect(transcript()).toHaveLength(0);
  });
});
