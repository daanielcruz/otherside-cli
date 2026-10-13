import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetDeliveredLoopInstructions,
  loopSkillPrompt,
  readLoopFile,
  resolveFirePrompt,
} from "@/engine/background/loop/autonomous.ts";
import {
  AUTONOMOUS_CHECK,
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  LOOP_CRON_TABLE,
  LOOP_FILE_DYNAMIC_SENTINEL,
  LOOP_FILE_SENTINEL,
} from "@/harness/skills/loop/prompts.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

let project: string;

function writeLoopFile(root: string, content: string): string {
  const path = join(root, ".otherside", "loop.md");
  mkdirSync(join(root, ".otherside"), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "loop-default-"));
  forgetDeliveredLoopInstructions();
});

afterEach(() => {
  forgetDeliveredLoopInstructions();
  rmSync(project, { recursive: true, force: true });
  rmSync(join(configRoot(), "loop.md"), { force: true });
});

describe("loopSkillPrompt", () => {
  it("fills the skill's placeholders when given a prompt", () => {
    const prompt = loopSkillPrompt("Table:\n{{LOOP_CRON_TABLE}}", "5m /babysit", project);
    expect(prompt).toBe(`Table:\n${LOOP_CRON_TABLE}`);
  });

  it("self-paces the autonomous check when given nothing", () => {
    const prompt = loopSkillPrompt("unused", "  ", project);
    expect(prompt).toStartWith("# /loop — autonomous default with dynamic pacing");
    expect(prompt).toContain(`the literal string \`${AUTONOMOUS_LOOP_DYNAMIC_SENTINEL}\``);
    expect(prompt).toEndWith(AUTONOMOUS_CHECK);
  });

  it("runs the project's loop-tasks file instead when there is one", () => {
    const path = writeLoopFile(project, "- keep the branch green\n");
    const prompt = loopSkillPrompt("unused", "", project);
    expect(prompt).toContain(`has a loop-tasks file at \`${path}\``);
    expect(prompt).toContain(`the literal string \`${LOOP_FILE_DYNAMIC_SENTINEL}\``);
    expect(prompt).toEndWith(`## Loop tasks (from ${path})\n\n- keep the branch green`);
  });

  it("schedules the default work on a cron when given only an interval", () => {
    const autonomous = loopSkillPrompt("unused", "every 2 hours", project);
    expect(autonomous).toContain("just the interval `2h`");
    expect(autonomous).toContain(`the literal string \`${AUTONOMOUS_LOOP_SENTINEL}\``);

    writeLoopFile(project, "- sweep the logs");
    expect(loopSkillPrompt("unused", "10m", project)).toContain(
      `the literal string \`${LOOP_FILE_SENTINEL}\``,
    );
  });
});

describe("readLoopFile", () => {
  it("prefers the project's file over the user's", () => {
    mkdirSync(configRoot(), { recursive: true });
    writeFileSync(join(configRoot(), "loop.md"), "- user tasks");
    expect(readLoopFile(project)?.content).toBe("- user tasks");
    writeLoopFile(project, "- project tasks");
    expect(readLoopFile(project)?.content).toBe("- project tasks");
  });

  it("cuts an oversized file at a line and says so", () => {
    writeLoopFile(project, `${"- task\n".repeat(5_000)}`);
    const content = readLoopFile(project)?.content ?? "";
    expect(content.length).toBeLessThan(25_200);
    expect(content).toEndWith(
      "> WARNING: loop.md was truncated to 25000 bytes. Keep the task list concise.",
    );
  });
});

describe("resolveFirePrompt", () => {
  it("delivers the autonomous instructions once, then a reminder, then again after a compaction", () => {
    const first = resolveFirePrompt(AUTONOMOUS_LOOP_SENTINEL, project);
    const second = resolveFirePrompt(AUTONOMOUS_LOOP_SENTINEL, project);
    forgetDeliveredLoopInstructions();
    const afterCompaction = resolveFirePrompt(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL, project);

    expect(first).toStartWith(AUTONOMOUS_CHECK);
    expect(second).toStartWith("# Autonomous loop tick\n");
    expect(second).not.toContain(AUTONOMOUS_CHECK);
    expect(afterCompaction).toStartWith(AUTONOMOUS_CHECK);
    expect(afterCompaction).toContain(`\`${AUTONOMOUS_LOOP_DYNAMIC_SENTINEL}\``);
  });

  it("delivers the loop-tasks file again when it was edited", () => {
    writeLoopFile(project, "- first list");
    expect(resolveFirePrompt(LOOP_FILE_SENTINEL, project)).toContain("- first list");
    expect(resolveFirePrompt(LOOP_FILE_SENTINEL, project)).toStartWith(
      "# /loop tick — loop.md tasks\n",
    );
    writeLoopFile(project, "- second list");
    expect(resolveFirePrompt(LOOP_FILE_SENTINEL, project)).toContain("- second list");
  });

  it("falls back to the autonomous check when the loop-tasks file is gone", () => {
    const prompt = resolveFirePrompt(LOOP_FILE_DYNAMIC_SENTINEL, project);
    expect(prompt).toStartWith(AUTONOMOUS_CHECK);
    expect(prompt).toContain("# /loop tick — loop.md absent (dynamic pacing)");
  });

  it("fires any other prompt as written", () => {
    expect(resolveFirePrompt("/loop check the deploy", project)).toBe("/loop check the deploy");
  });
});
