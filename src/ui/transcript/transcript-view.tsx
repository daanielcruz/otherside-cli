import * as React from "react";
import { bumpTranscriptMemoBreak, bumpTranscriptRender } from "@/devtools/render/counters.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import { Box } from "@/ink";
import { Welcome } from "@/ui/chrome/welcome.tsx";
import { BgTaskLog } from "@/ui/transcript/blocks/bg-task-log.tsx";
import { Log } from "@/ui/transcript/blocks/log.tsx";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface TranscriptViewProps {
  viewingTask: BackgroundTask | undefined;
  viewingAgentEntries: readonly TranscriptEntry[];
  logEpoch: number;
  transcript: readonly TranscriptEntry[];
  liveEntries: readonly TranscriptEntry[];
  showIntro: boolean;
  version: string;
  greeting: string | undefined;
  providerShortKey: string;
  currentModel: string;
}

const EMPTY_LIVE_ENTRIES: readonly TranscriptEntry[] = [];

function TranscriptViewImpl(props: TranscriptViewProps): React.JSX.Element {
  bumpTranscriptRender();
  if (props.viewingTask && props.viewingTask.kind === "shell") {
    return <BgTaskLog task={props.viewingTask} />;
  }
  if (props.viewingTask) {
    return (
      <Box flexDirection="column">
        <Log
          entries={props.viewingAgentEntries}
          liveEntries={EMPTY_LIVE_ENTRIES}
          intro={null}
          providerShortKey={props.providerShortKey}
          currentModel={props.currentModel}
        />
        {props.viewingTask.status !== "running" && <Box height={1} />}
      </Box>
    );
  }
  return (
    <Log
      key={props.logEpoch}
      entries={props.transcript}
      liveEntries={props.liveEntries}
      intro={props.showIntro ? <Welcome version={props.version} greeting={props.greeting} /> : null}
      providerShortKey={props.providerShortKey}
      currentModel={props.currentModel}
    />
  );
}

function liveEntriesEqual(a: readonly TranscriptEntry[], b: readonly TranscriptEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.kind !== y.kind || x.text !== y.text || x.streaming !== y.streaming) {
      return false;
    }
  }
  return true;
}

function transcriptMemoBreakReason(
  prev: TranscriptViewProps,
  next: TranscriptViewProps,
): string | null {
  if (prev.viewingTask !== next.viewingTask) return "viewingTask";
  if (prev.viewingTask !== undefined) {
    if (prev.viewingAgentEntries !== next.viewingAgentEntries) return "viewingAgentEntries";
    if (prev.providerShortKey !== next.providerShortKey) return "providerShortKey";
    if (prev.currentModel !== next.currentModel) return "currentModel";
    return null;
  }
  if (prev.logEpoch !== next.logEpoch) return "logEpoch";
  if (prev.transcript !== next.transcript) {
    return prev.transcript.length !== next.transcript.length ? "transcript-len" : "transcript-ref";
  }
  if (prev.providerShortKey !== next.providerShortKey) return "providerShortKey";
  if (prev.currentModel !== next.currentModel) return "currentModel";
  if (prev.showIntro !== next.showIntro) return "showIntro";
  if (prev.version !== next.version) return "version";
  if (prev.greeting !== next.greeting) return "greeting";
  if (!liveEntriesEqual(prev.liveEntries, next.liveEntries)) return "liveEntries";
  return null;
}

export const TranscriptView = React.memo(TranscriptViewImpl, (prev, next) => {
  const reason = transcriptMemoBreakReason(prev, next);
  if (reason === null) return true;
  bumpTranscriptMemoBreak(reason);
  return false;
});
