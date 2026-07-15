import { memo, type ReactNode, useRef } from "react";
import { isInterruptionMessage } from "@/engine/queue/runtime/interruption-text.ts";
import { Box, useTerminalDimensions } from "@/ink";
import { AssistantRow, CompactionRow, SkillCompletionRow, ThinkingRow } from "../assistant.tsx";
import { SkillRow } from "../skill.tsx";
import { OffscreenFreeze } from "../stream/offscreen-freeze.tsx";
import { isPendingId, isUnsettledUserEcho } from "../stream/static-flush.ts";
import {
  ApiErrorRow,
  AskAnswerRow,
  CommandOutputRow,
  InterruptionRow,
  QuotaGutterRow,
  RetryRow,
  SlashErrorRow,
  SystemRow,
} from "../system.tsx";
import { ToolEntryRow } from "../tool.tsx";
import type { TranscriptEntry } from "../types";
import { UserRow } from "../user.tsx";
import { parseTaskNotice, TaskNotice } from "./task-notice.tsx";

export {
  isRetryCountdownSettled,
  retryCountdownDeadline,
} from "../stream/retry.ts";

export interface LogProps {
  entries: readonly TranscriptEntry[];
  liveEntries?: readonly TranscriptEntry[];
  intro?: ReactNode;
  providerShortKey: string;
  currentModel?: string;
}

type StaticItem = { kind: "intro"; node: ReactNode } | { kind: "entry"; entry: TranscriptEntry };

export function Log({
  entries,
  liveEntries = [],
  intro,
  providerShortKey,
  currentModel,
}: LogProps): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  const introRef = useRef<ReactNode | null>(null);
  if (intro !== null && intro !== undefined && introRef.current === null) introRef.current = intro;

  // Settled rows stay in the frame for the app's lifetime (frozen once
  // offscreen, so they cost no diff). The terminal materializes scrollback by
  // itself as the frame grows; nothing is ever printed behind the frame's
  // back, which keeps every full reset able to rebuild the visible region.
  const settled: StaticItem[] = [];
  const pending: TranscriptEntry[] = [];
  if (introRef.current) settled.push({ kind: "intro", node: introRef.current });
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;
  for (const entry of entries) {
    if (isPendingId(entry.id) || isUnsettledUserEcho(entry, lastEntry)) {
      pending.push(entry);
    } else {
      settled.push({ kind: "entry", entry });
    }
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {settled.map((item) => {
        if (item.kind === "intro") {
          return (
            <OffscreenFreeze key="intro">
              <Box width={Math.max(20, columns)} justifyContent="center">
                {item.node}
              </Box>
            </OffscreenFreeze>
          );
        }
        return (
          <OffscreenFreeze key={item.entry.id}>
            <EntryRow
              entry={item.entry}
              width={columns}
              providerShortKey={providerShortKey}
              {...(currentModel !== undefined ? { currentModel } : {})}
            />
          </OffscreenFreeze>
        );
      })}
      {/* Pending rows are the ones that KEEP re-rendering (in-progress tools,
          elapsed counters, agent progress). Those updates are state-driven, so
          the clock's visibility gate never sees them — an unfrozen pending row
          that crossed the fold mutates scrollback and forces one full terminal
          reset per update. */}
      {pending.map((entry) => (
        <OffscreenFreeze key={entry.id}>
          <EntryRow
            entry={entry}
            width={columns}
            providerShortKey={providerShortKey}
            {...(currentModel !== undefined ? { currentModel } : {})}
          />
        </OffscreenFreeze>
      ))}
      {liveEntries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          width={columns}
          providerShortKey={providerShortKey}
          {...(currentModel !== undefined ? { currentModel } : {})}
        />
      ))}
    </Box>
  );
}

const EntryRow = memo(function EntryRowImpl({
  entry,
  width,
  providerShortKey,
  currentModel,
}: {
  entry: TranscriptEntry;
  width: number;
  providerShortKey: string;
  currentModel?: string;
}): React.JSX.Element | null {
  if (entry.kind === "thinking")
    return <ThinkingRow text={entry.text} streaming={entry.streaming === true} />;
  if (entry.kind !== "tool" && isInterruptionMessage(entry.text)) return <InterruptionRow />;
  if (entry.kind === "user")
    return (
      <UserRow
        text={entry.text}
        anchor={entry.anchor}
        width={width}
        images={entry.images}
        contextUsage={entry.contextUsage}
      />
    );
  if (entry.kind === "slash_error") return <SlashErrorRow text={entry.text} />;
  if (entry.kind === "command_output") return <CommandOutputRow text={entry.text} />;
  if (entry.kind === "ask_answer")
    return (
      <AskAnswerRow
        {...(entry.askPayload ? { payload: entry.askPayload } : {})}
        text={entry.text}
      />
    );
  if (entry.kind === "skill") {
    return (
      <SkillRow
        progress={entry.progress ?? []}
        isError={entry.isError ?? false}
        width={width}
        skillName={entry.skillName}
        startedAt={entry.startedAt}
        completedAt={entry.completedAt}
        inputTokens={entry.inputTokens}
        outputTokens={entry.outputTokens}
        isActive={entry.isActive === true}
      />
    );
  }
  if (entry.kind === "quota_gutter") {
    return <QuotaGutterRow text={entry.text} />;
  }
  if (entry.kind === "api_error") {
    return <ApiErrorRow text={entry.text} />;
  }
  if (entry.kind === "retry") {
    return <RetryRow text={entry.text} input={entry.input} />;
  }
  if (entry.kind === "task_notice") {
    const notice = parseTaskNotice(entry.text);
    return notice ? <TaskNotice notice={notice} /> : null;
  }
  if (entry.kind === "tool") {
    return (
      <ToolEntryRow
        entry={entry}
        providerShortKey={providerShortKey}
        {...(currentModel !== undefined ? { currentModel } : {})}
      />
    );
  }
  if (entry.kind === "assistant" && !entry.isError) {
    return <AssistantRow entry={entry} width={width} />;
  }
  if (entry.id.startsWith("s_")) {
    return <SkillCompletionRow text={entry.text} isError={entry.isError === true} />;
  }
  if (
    entry.kind === "compaction" &&
    !entry.isError &&
    entry.filesRead &&
    entry.filesRead.length > 0
  ) {
    return <CompactionRow text={entry.text} filesRead={entry.filesRead} />;
  }
  return <SystemRow entry={entry} />;
});
