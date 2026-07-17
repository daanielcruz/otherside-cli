import { describe, expect, it } from "bun:test";
import {
  BASH_MODE_PREFIX,
  bashRunResultMeta,
  bashTurnBlocks,
  bashTurnText,
  parseBashTurnText,
  promptInputModeOf,
  runBashInput,
  stripBashPrefix,
  withPromptMode,
} from "@/engine/queue/turn/bash-input.ts";

describe("prompt input mode encoding", () => {
  it("classifies `!`-prefixed text as bash and everything else as prompt", () => {
    expect(promptInputModeOf("!ls")).toBe("bash");
    expect(promptInputModeOf("ls")).toBe("prompt");
    expect(promptInputModeOf("")).toBe("prompt");
    expect(promptInputModeOf(" !ls")).toBe("prompt");
  });

  it("round-trips a command through the storage form", () => {
    expect(withPromptMode("ls -la", "bash")).toBe("!ls -la");
    expect(stripBashPrefix("!ls -la")).toBe("ls -la");
    expect(stripBashPrefix("plain")).toBe("plain");
    expect(withPromptMode("plain", "prompt")).toBe("plain");
  });

  it("keeps an inner `!` intact", () => {
    expect(stripBashPrefix(`${BASH_MODE_PREFIX}echo hi!`)).toBe("echo hi!");
  });
});

describe("bashTurnBlocks", () => {
  it("wraps command, stdout, and stderr in their wire tags", () => {
    const blocks = bashTurnBlocks("echo hi", { stdout: "hi\n", stderr: "", exitCode: 0 });
    expect(blocks).toEqual([
      { type: "text", text: "<bash-input>echo hi</bash-input>\n" },
      { type: "text", text: "<bash-stdout>hi\n</bash-stdout><bash-stderr></bash-stderr>" },
    ]);
  });

  it("XML-escapes stdout and stderr but not the command", () => {
    const blocks = bashTurnBlocks("grep '<tag>'", {
      stdout: "<tag> & more",
      stderr: "warn <x>",
      exitCode: 1,
    });
    expect(blocks[0]?.type === "text" && blocks[0].text).toContain("<bash-input>grep '<tag>'");
    expect(blocks[1]?.type === "text" && blocks[1].text).toBe(
      "<bash-stdout>&lt;tag&gt; &amp; more</bash-stdout><bash-stderr>warn &lt;x&gt;</bash-stderr>",
    );
  });
});

describe("parseBashTurnText", () => {
  it("round-trips bashTurnText including escaped output", () => {
    const run = { stdout: "a <b> & c", stderr: "err <e>", exitCode: 0 };
    const parsed = parseBashTurnText(bashTurnText("cmd '<x>'", run));
    expect(parsed).toEqual({ command: "cmd '<x>'", stdout: "a <b> & c", stderr: "err <e>" });
  });

  it("returns null for non-bash user content", () => {
    expect(parseBashTurnText("plain prompt")).toBeNull();
    expect(parseBashTurnText("<task-notification>x</task-notification>")).toBeNull();
  });
});

describe("runBashInput", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const run = await runBashInput("echo out; echo err 1>&2; exit 3");
    expect(run.stdout.trim()).toBe("out");
    expect(run.stderr.trim()).toBe("err");
    expect(run.exitCode).toBe(3);
  });

  it("reports a nonexistent command through stderr, never throwing", async () => {
    const run = await runBashInput("definitely-not-a-command-xyz");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.length).toBeGreaterThan(0);
  });
});

describe("bashRunResultMeta", () => {
  it("shapes the transcript gutter meta like a completed bash result", () => {
    expect(bashRunResultMeta({ stdout: "o", stderr: "e", exitCode: 2 })).toEqual({
      kind: "bash",
      status: "completed",
      exit_code: 2,
      stdout: "o",
      stderr: "e",
    });
  });
});
