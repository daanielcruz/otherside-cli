import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BashSchema,
  forgetDedicatedToolSteer,
  getBashPrompt,
  leanDedicatedToolSteer,
} from "@/engine/tools/dynamic/Bash.ts";
import { type BashTimeoutLimits, buildBashDescription } from "@/harness/tools/Bash/description.ts";
import { getRuntimeKind, setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";

const STEER = "IMPORTANT: Avoid using this tool to run";
const OUTPUT_NOTE = "- Command output is displayed to you, not reliably to the user.";

afterEach(() => {
  for (const id of ["yolo-session", "prompted-session"]) forgetDedicatedToolSteer(id);
});

describe("lean Bash description", () => {
  test("tells the model its command output is not what the user sees", () => {
    expect(getBashPrompt({ lean: true })).toContain(OUTPUT_NOTE);
  });

  test("drops the dedicated-tool steer only when asked to", () => {
    expect(getBashPrompt({ lean: true })).toContain(STEER);
    const trimmed = getBashPrompt({ lean: true, dedicatedToolSteer: false });
    expect(trimmed).not.toContain(STEER);
    expect(trimmed).toContain(OUTPUT_NOTE);
    expect(trimmed).not.toContain("{{");
    expect(trimmed).not.toMatch(/\n\n- Command output/);
  });

  test("the full description keeps its own steer", () => {
    expect(getBashPrompt({ lean: false, dedicatedToolSteer: false })).toContain(
      "IMPORTANT: Avoid using this tool to run",
    );
  });
});

describe("leanDedicatedToolSteer", () => {
  test("a session opened in yolo drops the steer and keeps that for the session", () => {
    expect(leanDedicatedToolSteer("yolo-session", "yolo")).toBe(false);
    expect(leanDedicatedToolSteer("yolo-session", "default")).toBe(false);
  });

  test("a session opened with prompts keeps the steer after switching to yolo", () => {
    expect(leanDedicatedToolSteer("prompted-session", "accept-edits")).toBe(true);
    expect(leanDedicatedToolSteer("prompted-session", "yolo")).toBe(true);
  });

  test("a finished session decides again", () => {
    expect(leanDedicatedToolSteer("yolo-session", "yolo")).toBe(false);
    forgetDedicatedToolSteer("yolo-session");
    expect(leanDedicatedToolSteer("yolo-session", "default")).toBe(true);
  });
});

const CUSTOM_LIMITS: BashTimeoutLimits = {
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 900_000,
  defaultBackgroundTimeoutMs: 2_400_000,
  maxBackgroundTimeoutMs: 9_000_000,
  backgroundDeadline: true,
};

function describeWithLimits(lean: boolean): string {
  return buildBashDescription({
    lean,
    sandbox: { enabled: false },
    includeGit: false,
    ...CUSTOM_LIMITS,
  });
}

function schemaProperty(name: string): { description?: string } | undefined {
  const properties = BashSchema.inputSchema.properties as Record<string, { description?: string }>;
  return properties[name];
}

const LEAN_BACKGROUND_LINE =
  "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits.";
const LEAN_BACKGROUND_LIMIT =
  " With it, `timeout` is how long the command may run in the background (default 1800000, max 7200000); at that limit it is stopped and you are re-invoked.";
const FULL_BACKGROUND_BULLET_END =
  "You do not need to use '&' at the end of the command when using this parameter.";
const FULL_BACKGROUND_LIMIT =
  " With `run_in_background` the timeout is instead how long the command may run in the background (default 1800000ms / 30 minutes, max 7200000ms / 2 hours); at that limit it is stopped and you are notified.";
const BACKGROUND_PARAMETER = "Set to true to run this command in the background.";
const BACKGROUND_PARAMETER_LIMIT =
  " With it, `timeout` limits how long the command may run in the background before it is stopped (default 1800000 ms, max 7200000 ms).";

let runtimeBefore: ReturnType<typeof getRuntimeKind>;

beforeEach(() => {
  runtimeBefore = getRuntimeKind();
});

afterEach(() => {
  setRuntimeKind(runtimeBefore);
});

describe("Bash timeout texts", () => {
  test("the lean timeout line limits a foreground command", () => {
    expect(getBashPrompt({ lean: true })).toContain(
      "- `timeout` is in milliseconds: default 120000, max 600000 for a foreground command.\n",
    );
  });

  test("the timeout parameter limits a foreground command", () => {
    expect(schemaProperty("timeout")?.description).toBe(
      "Optional timeout in milliseconds (max 600000 for a foreground command)",
    );
  });

  test("the lean description renders the configured limits", () => {
    const lean = describeWithLimits(true);
    expect(lean).toContain("default 5000, max 900000 for a foreground command.");
    expect(lean).toContain("(default 2400000, max 9000000); at that limit");
  });

  test("the full description renders the configured limits", () => {
    const full = describeWithLimits(false);
    expect(full).toContain("(up to 900000ms / 15 minutes)");
    expect(full).toContain("will timeout after 5000ms (0.08333333333333333 minutes)");
    expect(full).toContain("(default 2400000ms / 40 minutes, max 9000000ms / 2.5 hours)");
  });

  test("the schema renders the limits configured in the environment", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { setRuntimeKind } = await import(${JSON.stringify(join(import.meta.dir, "../../../../kernel/std/proc/runtime-mode.ts"))});
         setRuntimeKind("print");
         const { BashSchema } = await import(${JSON.stringify(join(import.meta.dir, "../Bash.ts"))});
         const { timeout, run_in_background } = BashSchema.inputSchema.properties;
         console.log(JSON.stringify([timeout.description, run_in_background.description]));`,
      ],
      {
        env: { ...process.env, BASH_DEFAULT_TIMEOUT_MS: "2400000", BASH_MAX_TIMEOUT_MS: "9000000" },
        stdout: "pipe",
      },
    );
    const [timeout, runInBackground] = JSON.parse(await new Response(child.stdout).text());
    expect(timeout).toContain("(max 9000000 for a foreground command)");
    expect(runInBackground).toContain("(default 2400000 ms, max 9000000 ms)");
  });
});

describe("Bash background time limit texts in a session without a terminal", () => {
  beforeEach(() => {
    setRuntimeKind("print");
  });

  test("the lean run_in_background line states the background limit", () => {
    expect(getBashPrompt({ lean: true })).toContain(
      `${LEAN_BACKGROUND_LINE}${LEAN_BACKGROUND_LIMIT} No \`&\` needed.`,
    );
  });

  test("the full run_in_background bullet ends with the background limit", () => {
    expect(getBashPrompt({ lean: false })).toContain(
      `${FULL_BACKGROUND_BULLET_END}${FULL_BACKGROUND_LIMIT}\n`,
    );
  });

  test("the run_in_background parameter states the background limit", () => {
    expect(schemaProperty("run_in_background")?.description).toBe(
      `${BACKGROUND_PARAMETER}${BACKGROUND_PARAMETER_LIMIT}`,
    );
  });

  test("a piped session names the limit too", () => {
    setRuntimeKind("piped");
    expect(getBashPrompt({ lean: true })).toContain(LEAN_BACKGROUND_LIMIT);
  });
});

describe("Bash background texts in an interactive session", () => {
  beforeEach(() => {
    setRuntimeKind("interactive");
  });

  test("the lean run_in_background line names no time limit", () => {
    const lean = getBashPrompt({ lean: true });
    expect(lean).toContain(`${LEAN_BACKGROUND_LINE} No \`&\` needed.`);
    expect(lean).not.toContain("at that limit");
    expect(lean).not.toContain("{{");
  });

  test("the full run_in_background bullet names no time limit", () => {
    const full = getBashPrompt({ lean: false });
    expect(full).toContain(`${FULL_BACKGROUND_BULLET_END}\n`);
    expect(full).not.toContain("at that limit");
    expect(full).not.toContain("{{");
  });

  test("the run_in_background parameter only says what it does", () => {
    expect(schemaProperty("run_in_background")?.description).toBe(BACKGROUND_PARAMETER);
  });

  test("the schema stays the same object while the answer holds", () => {
    expect(BashSchema.inputSchema).toBe(BashSchema.inputSchema);
  });
});
