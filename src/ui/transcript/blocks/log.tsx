import { memo, type ReactNode, useRef } from "react";
import { isInterruptionMessage } from "@/engine/queue/runtime/interruption-text.ts";
import { Box, useTerminalDimensions } from "@/ink";
import { AssistantRow, CompactionRow, SkillCompletionRow, ThinkingRow } from "../assistant.tsx";
import { BashInputRow } from "../bash-input.tsx";
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
import { PlainTaskNotice, parseTaskNotice, TaskNotice } from "./task-notice.tsx";

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
  //
  // Settled rows render first, then still-pending rows (in-progress tools,
  // elapsed counters, agent progress — the ones that KEEP re-rendering; a
  // pending row that crossed the fold and is not frozen mutates scrollback and
  // forces one full terminal reset per update). Both groups emit into a SINGLE
  // reconciliation list. Splitting them across two sibling arrays put the two
  // groups in different implicit-fragment keyspaces, so a row moving from
  // pending to settled at completion — the settle boundary — was reconciled as
  // an unmount+remount rather than an in-place update. A remounted row cannot
  // update the copy the retained frame already froze offscreen: the stale
  // pending row is stranded in the frame while the completion paints as a fresh
  // row (the duplicated tool row). One list keeps the boundary an in-place move.
  const settled: StaticItem[] = [];
  const pending: StaticItem[] = [];
  if (introRef.current) settled.push({ kind: "intro", node: introRef.current });
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;
  for (const entry of entries) {
    if (isPendingId(entry.id) || isUnsettledUserEcho(entry, lastEntry)) {
      pending.push({ kind: "entry", entry });
    } else {
      settled.push({ kind: "entry", entry });
    }
  }
  const frameItems: StaticItem[] = [...settled, ...pending];

  return (
    <Box flexDirection="column" flexShrink={0}>
      {frameItems.map((item) => {
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
          <OffscreenFreeze key={frameRowKey(item.entry)}>
            <EntryRow
              entry={item.entry}
              width={columns}
              providerShortKey={providerShortKey}
              {...(currentModel !== undefined ? { currentModel } : {})}
            />
          </OffscreenFreeze>
        );
      })}
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

// A tool row changes id across its lifecycle (running `t_…` → completed `r_…`
// → backgrounded `b_…`) while keeping the same call id and the same transcript
// slot (the store replaces it in place). Key it by the stable call id so the
// run→complete transition reconciles as an in-place update; keying by the raw
// id would remount the row at completion and strand its frozen pending copy in
// the retained frame. Every other row keeps its id.
function frameRowKey(entry: TranscriptEntry): string {
  return entry.kind === "tool" ? `tool:${entry.id.replace(/^[a-z]+_/, "")}` : entry.id;
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
  if (entry.kind === "bash_input")
    return <BashInputRow command={entry.text} resultMeta={entry.resultMeta} width={width} />;
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
    if (notice) return <TaskNotice notice={notice} />;
    // Non-JSON notice text (resume rebuild, parked-notification injections)
    // still owns a visible row — a delivered notification must never vanish.
    return <PlainTaskNotice text={entry.text} isError={entry.isError === true} />;
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
