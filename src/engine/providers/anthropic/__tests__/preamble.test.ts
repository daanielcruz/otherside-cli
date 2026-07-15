import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_OPENER,
  SYSTEM_OPENER,
  subagentBillingHeader,
  systemBillingHeader,
} from "../preamble.ts";

describe("billing header cc_prev_req", () => {
  test("omits cc_prev_req when there is no previous request", () => {
    const header = systemBillingHeader("hello world");
    expect(header).toContain("cc_entrypoint=cli;");
    expect(header).not.toContain("cc_prev_req");
    expect(header).not.toContain("cc_is_subagent");
  });

  test("appends cc_prev_req last for a main-turn chain", () => {
    const header = systemBillingHeader("hello world", "req_011CceFg6SjrwZ8jcYi97EmG");
    expect(header).toContain("cc_entrypoint=cli;");
    expect(header).not.toContain("cc_is_subagent");
    expect(header.endsWith("cc_prev_req=req_011CceFg6SjrwZ8jcYi97EmG;")).toBe(true);
  });

  test("subagent header carries cc_is_subagent then cc_prev_req, in that order", () => {
    const header = subagentBillingHeader("hello world", "req_011CceFgVZY4ajgzhkHvmtKF");
    expect(header.endsWith("cc_is_subagent=true; cc_prev_req=req_011CceFgVZY4ajgzhkHvmtKF;")).toBe(
      true,
    );
    expect(header.indexOf("cc_is_subagent")).toBeLessThan(header.indexOf("cc_prev_req"));
  });

  test("subagent header without a previous request keeps only cc_is_subagent", () => {
    const header = subagentBillingHeader("hello world");
    expect(header.endsWith("cc_is_subagent=true;")).toBe(true);
    expect(header).not.toContain("cc_prev_req");
  });
});

describe("system openers", () => {
  test("main opener is the interactive CLI prefix", () => {
    expect(SYSTEM_OPENER).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  test("subagent opener is the agent-SDK prefix", () => {
    expect(SUBAGENT_OPENER).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  });
});
