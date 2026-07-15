import { describe, expect, it } from "bun:test";
import {
  backgroundTaskNoticeIdentity,
  recordBackgroundTaskTransition,
} from "@/ui/app/hooks/use-async-completion-resume.ts";

describe("background completion notice transitions", () => {
  it("renders each completed generation once", () => {
    const transitionedTasks = new Set<string>();
    const notices: string[] = [];
    const appendNotice = (taskId: string, runGeneration: number): void => {
      const replayKey = backgroundTaskNoticeIdentity(taskId, runGeneration);
      if (!recordBackgroundTaskTransition(transitionedTasks, replayKey)) return;
      notices.push(`n_${replayKey}`);
    };

    appendNotice("task-1", 0);
    appendNotice("task-1", 1);
    appendNotice("task-1", 1);

    expect(notices).toEqual(["n_bg:task-1:0", "n_bg:task-1:1"]);
  });
});
