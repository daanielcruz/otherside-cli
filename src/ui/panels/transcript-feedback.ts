import { transcriptActions } from "@/store/transcript/index.ts";
import { nextTranscriptId } from "@/store/turn-tracking/index.ts";

/**
 * Panel work whose outcome outlives the overlay reports through the transcript,
 * anchored under the command that opened the panel — the reader sees
 * `❯ /plugins` with the result as its child line, never an orphan row.
 * Consecutive results reuse a trailing anchor instead of repeating it.
 */
export function publishPanelTranscriptLine(command: string, text: string, isError = false): void {
  transcriptActions.update((entries) => {
    const anchored = trailingAnchorIs(entries, command);
    const withAnchor = anchored
      ? entries
      : [
          ...entries,
          {
            id: nextTranscriptId("user"),
            kind: "user" as const,
            text: command,
            settlementState: "settled" as const,
          },
        ];
    return [
      ...withAnchor,
      {
        id: nextTranscriptId("cmd_out"),
        kind: "command_output" as const,
        text,
        settlementState: "settled" as const,
        ...(isError ? { isError } : {}),
      },
    ];
  });
}

function trailingAnchorIs(
  entries: readonly { kind: string; text: string }[],
  command: string,
): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "command_output") continue;
    return entry.kind === "user" && entry.text === command;
  }
  return false;
}
