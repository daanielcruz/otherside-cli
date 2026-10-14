import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Glyph } from "@/ui/theme/theme.ts";
import { taskNoticeReplayTextFromNotification } from "@/ui/transcript/records/entry-builders.ts";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

describe("a turn notice after resume", () => {
  const WARNING =
    "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn.";
  const NOTICE = "Goal paused · the goal check timed out · send a message to continue";

  it("replays from its record at the level it was shown with", () => {
    const records = [WARNING, NOTICE].map((text, index) => ({
      type: "attachment" as const,
      ts: "2026-01-01T00:00:00.000Z",
      attachment: { type: "turn_notice", text, level: index === 0 ? "warning" : "notice" },
    }));
    expect(sessionRecordsToTranscript(records)).toEqual([
      { id: "rec_0", kind: "system", text: WARNING, level: "warning" },
      { id: "rec_1", kind: "system", text: NOTICE, level: "notice" },
    ]);
  });

  it("is drawn with a bullet, unlike a plain system line", () => {
    const rowOf = (text: string, level?: "warning" | "notice"): string | undefined => {
      const view = new StringViewTranscript();
      view.setEntries([
        { kind: "system", text, isError: false, ...(level !== undefined ? { level } : {}) },
      ]);
      return view
        .render(200)
        .map(stripAnsi)
        .find((row) => row.includes(text));
    };
    expect(rowOf(WARNING, "warning")).toBe(`${Glyph.bullet} ${WARNING}`);
    expect(rowOf(NOTICE, "notice")).toBe(`${Glyph.bullet} ${NOTICE}`);
    expect(rowOf(WARNING)).not.toStartWith(Glyph.bullet);
  });
});

describe("a notification no task owns, after resume", () => {
  it("replays as its own summary", () => {
    const text =
      "<task-notification>\n<summary>Goal check-in: continuing after the last turn ended early</summary>\n</task-notification>\n<system-reminder>\nbody\n</system-reminder>";
    expect(taskNoticeReplayTextFromNotification(text)).toBe(
      "Goal check-in: continuing after the last turn ended early",
    );
  });
});

function notification(summary: string, extra = ""): string {
  const escaped = summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<task-notification>\n<summary>${escaped}</summary>\n${extra}</task-notification>`;
}

describe("taskNoticeReplayTextFromNotification", () => {
  it("parses an agent finished summary", () => {
    const out = JSON.parse(
      taskNoticeReplayTextFromNotification(notification('Agent "deep audit" finished')),
    );
    expect(out.taskKind).toBe("agent");
    expect(out.description).toBe("deep audit");
    expect(out.status).toBe("completed");
  });

  it("parses an agent failure with error text", () => {
    const out = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification('Agent "deep audit" failed: provider timeout', "<status>failed</status>\n"),
      ),
    );
    expect(out.description).toBe("deep audit");
    expect(out.status).toBe("failed");
    expect(out.error).toBe("provider timeout");
  });

  it("prefers the structured error field", () => {
    const out = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification(
          'Agent "model check" failed: legacy cause',
          "<status>failed</status>\n<error>invalid model &amp; provider pin</error>\n",
        ),
      ),
    );

    expect(out.error).toBe("invalid model & provider pin");
  });

  it("parses a user-stopped agent", () => {
    const out = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification('Agent "deep audit" was stopped by user', "<status>killed</status>\n"),
      ),
    );
    expect(out.description).toBe("deep audit");
    expect(out.status).toBe("killed");
  });

  it("parses a shell completion with exit code", () => {
    const out = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification('Background command "build" completed (exit code 0)'),
      ),
    );
    expect(out.taskKind).toBe("shell");
    expect(out.description).toBe("build");
    expect(out.exitCode).toBe(0);
  });

  it("parses a shell failure with exit code", () => {
    const out = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification(
          'Background command "build" failed with exit code 3',
          "<status>failed</status>\n",
        ),
      ),
    );
    expect(out.taskKind).toBe("shell");
    expect(out.description).toBe("build");
    expect(out.exitCode).toBe(3);
    expect(out.status).toBe("failed");
  });

  it("prefers the duration_ms tag and falls back to the summary suffix", () => {
    const tagged = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification(
          'Agent "deep audit" finished',
          "<usage><subagent_tokens>10</subagent_tokens><tool_uses>2</tool_uses><duration_ms>4500</duration_ms></usage>\n",
        ),
      ),
    );
    expect(tagged.durationMs).toBe(4500);
    const suffixed = JSON.parse(
      taskNoticeReplayTextFromNotification(
        notification('Dynamic workflow "sweep" completed · 2m 5s'),
      ),
    );
    expect(suffixed.taskKind).toBe("workflow");
    expect(suffixed.description).toBe("sweep");
    expect(suffixed.durationMs).toBe(125_000);
  });
});
