import { list as listBackgroundTasks } from "@/engine/background/tasks/background.ts";
import type { TurnObserver } from "@/engine/queue/turn/observer.ts";
import { appendRecord, nowIso, type Session } from "@/engine/session/index.ts";
import { resolveToolCompletion } from "@/engine/session/record/transcript-update.ts";
import type { TranscriptEntry, TranscriptWrite } from "@/engine/session/record/types.ts";
import { emitEnvBroadcast } from "@/kernel/channels/session-events.ts";
import { mcpCallIdentity } from "@/kernel/mcp/index.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

type SetState<T> = (value: T | ((prev: T) => T)) => void;
type Ref<T> = { current: T };
type BrokerState = ReturnType<BrokerHandle["read"]>;

function agentResultStatus(
  isError: boolean,
  taskStatus: "running" | "completed" | "error" | "killed",
): "failed" | "stopped" | "completed" {
  if (isError) return "failed";
  if (taskStatus === "killed") return "stopped";
  return "completed";
}

export interface ToolDispatchHandlersDeps {
  session: Session;
  turnState: BrokerState;
  endThinkingStatus: () => void;
  setSpinnerMode: (mode: "tool-use" | "requesting") => void;
  flushAssistant: (opts?: { allowEmpty?: boolean }) => Promise<TranscriptEntry[]>;
  setStreamingId: SetState<string | null>;
  setTranscript: (value: TranscriptWrite) => void;
  transcriptBatch: MacrotaskBatch;
  setTasksExpanded: SetState<boolean>;
  setAgentBackgrounded: (callId: string, route?: ProviderModelRoute) => void;
  agentModelByCallIdRef: Ref<Map<string, ProviderModelRoute>>;
  activeToolsRef: Ref<number>;
  forkActionRef: Ref<Map<string, { count: number; lastLabel: string; backgrounded: boolean }>>;
  currentAgentCallIdRef: Ref<string | null>;
  turnHadVisibleOutputRef: Ref<boolean>;
  agentBlockText: (toolName: string, callId: string, input: unknown) => string;
  askAnswerEntry: (content: string, id: string, meta?: ToolResultMeta) => TranscriptEntry | null;
  silentToolNames: ReadonlySet<string>;
}

type ToolDispatchHandlers = Pick<
  TurnObserver,
  | "tool_dispatch_start"
  | "tool_dispatch_complete"
  | "tool_dispatch_progress"
  | "tool_dispatch_backgrounded"
>;

export function createToolDispatchHandlers(deps: ToolDispatchHandlersDeps): ToolDispatchHandlers {
  const {
    session,
    turnState,
    endThinkingStatus,
    setSpinnerMode,
    flushAssistant,
    setStreamingId,
    setTranscript,
    transcriptBatch,
    setTasksExpanded,
    setAgentBackgrounded,
    agentModelByCallIdRef,
    activeToolsRef,
    forkActionRef,
    currentAgentCallIdRef,
    turnHadVisibleOutputRef,
    agentBlockText,
    askAnswerEntry,
    silentToolNames,
  } = deps;

  const settleSpinnerWithTranscript = (shouldRequestModel: boolean): void => {
    if (!shouldRequestModel) return;
    transcriptBatch.enqueue(() => setSpinnerMode("requesting"));
    transcriptBatch.flushNow();
  };

  return {
    tool_dispatch_start: async (ev) => {
      endThinkingStatus();
      emitEnvBroadcast(
        JSON.stringify({
          op: "tool_start",
          session_id: session.id,
          ts: nowIso(),
          call_id: ev.id,
          tool: ev.name,
        }),
      );
      activeToolsRef.current += 1;
      setSpinnerMode("tool-use");
      const flushed = await flushAssistant();
      if (flushed.length > 0) setStreamingId(null);
      // Captured now because only a live server knows it: the label is rebuilt
      // from here once the server is gone.
      const mcpIdentity = mcpCallIdentity(ev.name);
      await appendRecord(session, {
        type: "tool_call",
        ts: nowIso(),
        tool_name: ev.name,
        args: ev.input,
        call_id: ev.id,
        ...(mcpIdentity ? { mcpIdentity } : {}),
        provider: turnState.provider,
        model: turnState.model,
      });
      if (ev.name === "Agent") {
        currentAgentCallIdRef.current = ev.id;
        agentModelByCallIdRef.current.delete(ev.id);
        forkActionRef.current.set(ev.id, {
          count: 0,
          lastLabel: "Initializing…",
          backgrounded: false,
        });
      }
      if (ev.name === "TaskCreate" || ev.name === "TaskUpdate") {
        setTasksExpanded(true);
      }
      if (!silentToolNames.has(ev.name)) {
        turnHadVisibleOutputRef.current = true;
        const id = `t_${ev.id}`;
        setTranscript((t) => [
          ...t,
          {
            id,
            kind: "tool",
            title: ev.name,
            text: agentBlockText(ev.name, ev.id, ev.input),
            startedAt: Date.now(),
          },
        ]);
      }
    },
    tool_dispatch_complete: async (ev) => {
      activeToolsRef.current = Math.max(0, activeToolsRef.current - 1);
      emitEnvBroadcast(
        JSON.stringify({
          op: "tool_complete",
          session_id: session.id,
          ts: nowIso(),
          call_id: ev.id,
          tool: ev.name,
        }),
      );
      const shouldRequestModel = activeToolsRef.current === 0;
      const startId = `t_${ev.id}`;
      const completeId = `r_${ev.id}`;
      const agentRoute = ev.name === "Agent" ? agentModelByCallIdRef.current.get(ev.id) : undefined;
      if (ev.name === "Agent") {
        agentModelByCallIdRef.current.delete(ev.id);
        forkActionRef.current.delete(ev.id);
        if (currentAgentCallIdRef.current === ev.id) {
          currentAgentCallIdRef.current = null;
        }
      }
      let recordText = ev.content;
      let displayText = ev.displayContent ?? ev.content;
      if (ev.name === "Agent") {
        const task = listBackgroundTasks().find((t) => t.parentToolCallId === ev.id);
        if (task) {
          displayText = JSON.stringify({
            status: agentResultStatus(ev.isError, task.status),
            subagent_type: task.agentName,
            description: task.description ?? "",
            totalToolUseCount: task.actions.length,
            totalTokens: task.inputTokens + task.outputTokens,
            totalDurationMs: task.endedAt ? task.endedAt - task.startedAt : 0,
          });
          recordText = displayText;
        }
      }
      await appendRecord(session, {
        type: "tool_result",
        ts: nowIso(),
        call_id: ev.id,
        result: recordText,
        is_error: ev.isError,
        ...(ev.meta ? { meta: ev.meta } : {}),
        ...(agentRoute ? { agentModel: agentRoute.model } : {}),
      });
      if (ev.name === "AskUserQuestion") {
        const askEntry = askAnswerEntry(ev.content, `aq_${ev.id}`, ev.meta);
        if (askEntry) setTranscript((t) => [...t, askEntry]);
      }
      if (!silentToolNames.has(ev.name)) {
        const backgroundedId = `b_${ev.id}`;
        setTranscript((t) => {
          const idx = t.findIndex((entry) => entry.id === startId || entry.id === backgroundedId);
          const inputText = idx === -1 ? undefined : t[idx]?.text;
          const nextEntry: TranscriptEntry = {
            id: completeId,
            kind: "tool",
            title: ev.name,
            text: displayText,
            isError: ev.isError,
            ...(inputText !== undefined ? { input: inputText } : {}),
            ...(agentRoute
              ? { agentModel: agentRoute.model, agentProvider: agentRoute.provider }
              : {}),
            ...(ev.meta ? { resultMeta: ev.meta } : {}),
          };
          return resolveToolCompletion(t, {
            runningId: startId,
            backgroundedId,
            resolved: nextEntry,
          });
        });
      }
      settleSpinnerWithTranscript(shouldRequestModel);
    },
    tool_dispatch_progress: (ev) => {
      if (ev.progress.kind === "text") {
        const liveId = `t_${ev.id}`;
        const liveText = ev.progress.text;
        setTranscript((t) => {
          const idx = t.findIndex((entry) => entry.id === liveId);
          if (idx === -1) return t;
          const existing = t[idx];
          if (!existing || existing.liveOutput === liveText) return t;
          const out = [...t];
          out[idx] = { ...existing, liveOutput: liveText };
          return out;
        });
      }
    },
    tool_dispatch_backgrounded: (ev) => {
      const agentRoute = ev.name === "Agent" ? agentModelByCallIdRef.current.get(ev.id) : undefined;
      activeToolsRef.current = Math.max(0, activeToolsRef.current - 1);
      const shouldRequestModel = activeToolsRef.current === 0;
      setAgentBackgrounded(ev.id, agentRoute);
      settleSpinnerWithTranscript(shouldRequestModel);
      if (ev.name === "Agent") agentModelByCallIdRef.current.delete(ev.id);
      forkActionRef.current.delete(ev.id);
      if (currentAgentCallIdRef.current === ev.id) {
        currentAgentCallIdRef.current = null;
      }
    },
  };
}
