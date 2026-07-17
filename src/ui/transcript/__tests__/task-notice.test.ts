import { describe, expect, it } from "bun:test";
import {
  buildAgentSummary,
  buildCompletionNotification,
} from "@/engine/background/tasks/notification.ts";
import { resolveModelPin } from "@/engine/model/facts/model-pin.ts";
import { parseTaskNotice, taskNoticeText } from "@/ui/transcript/blocks/task-notice.tsx";
import { taskNoticeReplayTextFromNotification } from "@/ui/transcript/records/entry-builders.ts";

describe("task notice failure propagation", () => {
  it("keeps a classified cause through live JSON parsing", () => {
    const cause = "rate limited (anthropic/claude-fable-5): overloaded — 4 retries over 31s";
    const notice = parseTaskNotice(
      JSON.stringify({
        taskKind: "agent",
        status: "failed",
        description: "provider survey",
        durationMs: 31_000,
        error: cause,
      }),
    );

    expect(notice).not.toBeNull();
    expect(taskNoticeText(notice!)).toContain(cause);
    expect(taskNoticeText(notice!)).not.toContain("Unknown error");
  });

  it("keeps an invalid explicit model cause through replay and resume parsing", () => {
    const resolution = resolveModelPin("codex", "definitely-invalid-model");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected an invalid model pin");

    const notification = buildCompletionNotification({
      taskId: "invalid-model-task",
      status: "failed",
      summary: buildAgentSummary("invalid explicit model", "failed", {
        error: resolution.error,
      }),
      error: resolution.error,
    });
    const replayText = taskNoticeReplayTextFromNotification(notification);
    const replayed = parseTaskNotice(replayText);

    expect(replayed).not.toBeNull();
    expect(taskNoticeText(replayed!)).toContain(resolution.error);
    expect(taskNoticeText(replayed!)).not.toContain("Unknown error");
  });
});
