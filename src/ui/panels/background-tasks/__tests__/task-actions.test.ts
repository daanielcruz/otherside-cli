import { afterEach, describe, expect, it } from "bun:test";
import {
  type BackgroundTask,
  clear as clearBackgroundTasks,
  get as getBackgroundTask,
  resetEmitThrottleForTests,
  startTask,
} from "@/engine/background/tasks/background.ts";
import { killAllRunningAgents } from "@/ui/panels/background-tasks/task-actions.ts";

afterEach(() => {
  clearBackgroundTasks();
  resetEmitThrottleForTests();
});

function started(kind: BackgroundTask["kind"], callId: string): BackgroundTask {
  return startTask({
    parentToolCallId: callId,
    agentName: kind === "shell" ? "shell" : "sample-agent",
    kind,
    description: "sample work",
    isBackgrounded: true,
  });
}

describe("killAllRunningAgents", () => {
  it("stops the live agents and leaves background shells alone", () => {
    const agent = started("agent", "call-actions-agent");
    const shell = started("shell", "call-actions-shell");

    expect(killAllRunningAgents([agent, shell])).toBe(1);

    expect(getBackgroundTask(agent.id)?.status).toBe("killed");
    expect(getBackgroundTask(shell.id)?.status).toBe("running");
  });

  it("counts nothing when no agent is running", () => {
    const shell = started("shell", "call-actions-shell-only");

    expect(killAllRunningAgents([shell])).toBe(0);
    expect(getBackgroundTask(shell.id)?.status).toBe("running");
  });
});
