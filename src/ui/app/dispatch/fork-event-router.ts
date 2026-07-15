import type { SetStateAction } from "react";
import { applyAgentIdentityToTranscript } from "@/engine/session/record/transcript-update.ts";
import type { RecordProviderUsageFn } from "@/engine/session/usage/record-provider-usage.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import { addLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { buildSkillCompletionSummary } from "@/ui/transcript/records/skill-completion.ts";
import type { NestedToolEntry, SkillProgressItem, TranscriptEntry } from "@/ui/transcript/types";

export interface ForkEventRouterDeps {
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
  forkToCallIdRef: { current: Map<string, string> };
  setAgentNested: (
    callId: string,
    mutator: (entries: NestedToolEntry[]) => NestedToolEntry[],
  ) => void;
  recordProviderUsage: RecordProviderUsageFn;
  broker: { read: () => { provider: ProviderId; model: string } };
}

export function createForkEventRouter(deps: ForkEventRouterDeps): {
  routeForkEvent: (event: ForkEvent) => void;
} {
  const { setTranscript, forkToCallIdRef, setAgentNested, recordProviderUsage, broker } = deps;

  const updateSkillEntry = (
    forkId: string,
    mutator: (entry: TranscriptEntry) => TranscriptEntry,
  ): void => {
    const skillId = `t_${forkId}`;
    setTranscript((t) => {
      const idx = t.findIndex((entry) => entry.id === skillId);
      if (idx === -1) return t;
      const out = [...t];
      const existing = out[idx];
      if (existing) out[idx] = mutator(existing);
      return out;
    });
  };

  const appendSkillText = (forkId: string, text: string): void => {
    updateSkillEntry(forkId, (entry) => {
      const progress = entry.progress ?? [];
      const last = progress[progress.length - 1];
      if (last && last.kind === "text") {
        const next: SkillProgressItem[] = [...progress];
        next[next.length - 1] = { kind: "text", text: last.text + text };
        return { ...entry, progress: next };
      }
      return { ...entry, progress: [...progress, { kind: "text", text }] };
    });
  };

  const trimSkillText = (forkId: string, chars: number): void => {
    updateSkillEntry(forkId, (entry) => {
      const progress = [...(entry.progress ?? [])];
      // The voided attempt's text is always a contiguous tail of trailing text
      // items (tools only dispatch after a stream completes), so a tail-trim
      // removes exactly the discarded chars.
      let remaining = chars;
      while (remaining > 0 && progress.length > 0) {
        const last = progress[progress.length - 1];
        if (!last || last.kind !== "text") break;
        if (last.text.length > remaining) {
          progress[progress.length - 1] = {
            kind: "text",
            text: last.text.slice(0, last.text.length - remaining),
          };
          remaining = 0;
        } else {
          remaining -= last.text.length;
          progress.pop();
        }
      }
      return { ...entry, progress };
    });
  };

  const pushSkillTool = (forkId: string, toolName: string, args: unknown): void => {
    updateSkillEntry(forkId, (entry) => {
      const progress = entry.progress ?? [];
      return {
        ...entry,
        progress: [...progress, { kind: "tool", toolName, args, status: "running" }],
      };
    });
  };

  const finalizeSkillTool = (forkId: string, toolName: string, isError: boolean): void => {
    updateSkillEntry(forkId, (entry) => {
      const progress = entry.progress ?? [];
      const next = [...progress];
      for (let i = next.length - 1; i >= 0; i--) {
        const item = next[i];
        if (
          item &&
          item.kind === "tool" &&
          item.toolName === toolName &&
          item.status === "running"
        ) {
          next[i] = { ...item, status: isError ? "error" : "ok" };
          break;
        }
      }
      return { ...entry, progress: next };
    });
  };

  const resolveParentCallId = (event: ForkEvent): string | null => {
    if (event.parentToolCallId) return event.parentToolCallId;
    if (event.kind === "sidechain_persist_error") return null;
    const mapped = forkToCallIdRef.current.get(event.forkId);
    if (mapped) return mapped;
    return null;
  };

  const isAgentFork = (event: ForkEvent): boolean => resolveParentCallId(event) !== null;

  const routeForkEvent = (event: ForkEvent): void => {
    if (event.kind === "fork_start") {
      const parentCallId = event.parentToolCallId;
      if (parentCallId) {
        forkToCallIdRef.current.set(event.forkId, parentCallId);
        setTranscript((t) =>
          applyAgentIdentityToTranscript(t, parentCallId, {
            model: event.model,
            name: event.name,
          }),
        );
        return;
      }
      setTranscript((t) => [
        ...t,
        {
          id: `t_${event.forkId}`,
          kind: "skill",
          text: "",
          skillName: event.name,
          progress: [],
          isActive: true,
          startedAt: Date.now(),
          inputTokens: 0,
          outputTokens: 0,
        },
      ]);
    } else if (event.kind === "fork_text_delta") {
      if (!isAgentFork(event)) {
        appendSkillText(event.forkId, event.text);
        // Only skill forks drive the main live meter (their progress block reads
        // it). Agent forks render under their own nested entry and must not feed
        // the main statusline's context estimate.
        addLiveOutputTokens(Math.round(event.text.length / 4));
      } else {
        const id = `t_fk_${event.forkId}`;
        setTranscript((t) => {
          const idx = t.findIndex((entry) => entry.id === id);
          if (idx === -1) return [...t, { id, kind: "assistant", text: event.text }];
          const next = [...t];
          const existing = next[idx];
          if (existing) next[idx] = { ...existing, text: existing.text + event.text };
          return next;
        });
      }
    } else if (event.kind === "fork_stream_reset") {
      if (event.discardedChars > 0) {
        if (!isAgentFork(event)) {
          trimSkillText(event.forkId, event.discardedChars);
          addLiveOutputTokens(-Math.round(event.discardedChars / 4));
        } else {
          const id = `t_fk_${event.forkId}`;
          setTranscript((t) => {
            const idx = t.findIndex((entry) => entry.id === id);
            if (idx === -1) return t;
            const next = [...t];
            const existing = next[idx];
            if (existing) {
              next[idx] = {
                ...existing,
                text: existing.text.slice(
                  0,
                  Math.max(0, existing.text.length - event.discardedChars),
                ),
              };
            }
            return next;
          });
        }
      }
    } else if (event.kind === "fork_tool_dispatch_start") {
      const parentCallId = resolveParentCallId(event);
      if (parentCallId === null) {
        pushSkillTool(event.forkId, event.toolName, event.input);
      } else {
        setAgentNested(parentCallId, (prev) => [
          ...prev,
          { toolName: event.toolName, args: event.input, running: true },
        ]);
      }
    } else if (event.kind === "fork_tool_dispatch_complete") {
      const parentCallId = resolveParentCallId(event);
      if (parentCallId === null) {
        finalizeSkillTool(event.forkId, event.toolName, event.isError);
      } else {
        setAgentNested(parentCallId, (prev) => {
          const idx = prev.findIndex((e) => e.toolName === event.toolName && e.running);
          if (idx === -1) return prev;
          const out = [...prev];
          const existing = out[idx];
          if (existing) out[idx] = { ...existing, running: false };
          return out;
        });
      }
    } else if (event.kind === "fork_usage") {
      if (event.isSnapshot) return;
      const usageState = broker.read();
      recordProviderUsage(
        event.provider ?? usageState.provider,
        event.model ?? usageState.model,
        event.inputTokens,
        event.outputTokens,
        event.thoughtTokens ?? 0,
        event.cacheCreationInputTokens ?? 0,
        event.cacheReadInputTokens ?? 0,
        { isFork: true },
      );
      if (resolveParentCallId(event) === null) {
        updateSkillEntry(event.forkId, (entry) => ({
          ...entry,
          inputTokens: (entry.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (entry.outputTokens ?? 0) + event.outputTokens,
        }));
      }
    } else if (event.kind === "fork_retry_status") {
      if (event.attempt < 1) {
      } else {
        const id = `retry_${event.forkId}`;
        setTranscript((t) => {
          const seconds = Math.max(1, Math.round(event.delayMs / 1000));
          const next: TranscriptEntry = {
            id,
            kind: "retry",
            text: event.reason,
            input: JSON.stringify({
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              seconds,
              startedAt: Date.now(),
            }),
          };
          const filtered = t.filter((entry) => entry.kind !== "retry");
          return [...filtered, next];
        });
      }
    } else if (event.kind === "fork_complete") {
      forkToCallIdRef.current.delete(event.forkId);
      const skillId = `t_${event.forkId}`;
      setTranscript((t) => {
        const idx = t.findIndex((entry) => entry.id === skillId);
        if (idx === -1) {
          // Agent-path fork has no skill entry, but may have a streaming
          // `t_fk_` text entry to finalize (rename to `fk_`).
          const fkIdx = t.findIndex((entry) => entry.id === `t_fk_${event.forkId}`);
          if (fkIdx === -1) return t;
          const out = [...t];
          const fkEntry = out[fkIdx];
          if (fkEntry) out[fkIdx] = { ...fkEntry, id: `fk_${event.forkId}` };
          return out;
        }
        const out = [...t];
        const existing = out[idx];
        if (!existing || existing.kind !== "skill") return out;
        out[idx] = {
          ...existing,
          id: `r_${event.forkId}`,
          isActive: false,
          isError: event.isError,
          completedAt: Date.now(),
        };
        const forkTextIdx = out.findIndex((entry) => entry.id === `t_fk_${event.forkId}`);
        if (forkTextIdx !== -1) {
          const forkText = out[forkTextIdx];
          if (forkText) out[forkTextIdx] = { ...forkText, id: `fk_${event.forkId}` };
        }
        const summary = buildSkillCompletionSummary(
          existing.skillName,
          event.output,
          event.isError,
        );
        if (summary !== null) {
          out.push({
            id: `s_${event.forkId}`,
            kind: "system",
            text: summary,
            isError: event.isError,
          });
        } else if (!event.isError && event.output.trim().length > 0) {
          // Prose-output skills (e.g. /dream) carry their deliverable in the
          // fork's final text. The runner appendRecord's it as an
          // assistant_message, so resume renders it as a markdown bullet row;
          // mirror that live here so live === resume rather than dropping it.
          out.push({
            id: `c_${event.forkId}`,
            kind: "assistant",
            text: event.output,
          });
        }
        return out;
      });
    }
  };

  return { routeForkEvent };
}
