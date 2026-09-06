import { describe, expect, test } from "bun:test";
import {
  isWorkflowEnabled,
  isWorkflowKeywordTriggerEnabled,
} from "@/engine/background/workflows/runtime/gate.ts";
import type { UserConfig } from "@/kernel/config/config.ts";

function config(over: Partial<UserConfig> = {}): UserConfig {
  return over as UserConfig;
}

describe("whether the keyword opts a turn in", () => {
  test("it does when nothing says otherwise", () => {
    expect(isWorkflowKeywordTriggerEnabled(config())).toBe(true);
  });

  test("it stops when the reader turns the trigger off", () => {
    // Someone writing about the feature rather than asking for it should not
    // have their turn opted in by the word.
    expect(isWorkflowKeywordTriggerEnabled(config({ workflowKeywordTrigger: false }))).toBe(false);
  });

  test("it is its own switch, not the workflow feature's", () => {
    const off = config({ workflowKeywordTrigger: false });
    expect(isWorkflowEnabled(off)).toBe(true);
    const noWorkflows = config({ enableWorkflows: false });
    expect(isWorkflowKeywordTriggerEnabled(noWorkflows)).toBe(true);
  });
});
