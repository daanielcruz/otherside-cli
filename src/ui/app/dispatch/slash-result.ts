import type { SetStateAction } from "react";
import { CATALOG, type PendingChange, type SlashResult } from "@/commands/index.ts";
import type { Agent } from "@/engine/queue/index.ts";
import {
  appendHookEventRecord,
  appendRecord,
  nowIso,
  persistLocalCommand,
  type Session,
} from "@/engine/session/index.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { submitPluginNotice } from "@/store/app-store/right-region-notices.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

type RunSubmittedTurn = (
  text: string,
  opts?: { suppressUserTranscript?: boolean },
) => Promise<void>;

export interface ApplySlashResultDeps {
  runSkill: (name: string, args: string, raw: string) => void;
  runningRef: { current: boolean };
  applyPendingChange: (change: PendingChange) => void;
  nextTranscriptId: (prefix: string) => string;
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
  agent: Agent;
  runSubmittedTurnRef: { current: RunSubmittedTurn };
  transcriptBatch: MacrotaskBatch;
  session: Session;
  broker: Broker;
  setPluginStatusNotice?: (notice: string | null) => void;
}

// A local command is recorded when it RAN and printed stdout-like feedback.
// skill/workflow become real turns (recorded as turns), unknown is an error
// surface, auth/external hand off to another surface, and /clear resets the
// session the records would land in.
const RECORDED_COMMAND_KINDS = ["instant", "toggle", "anchor", "panel"] as const;
const RECORDED_COMMAND_KIND_SET: ReadonlySet<string> = new Set(RECORDED_COMMAND_KINDS);

export function shouldRecordLocalCommand(result: SlashResult): boolean {
  return (
    !!result.command &&
    !!result.feedback &&
    RECORDED_COMMAND_KIND_SET.has(result.kind) &&
    result.command.name !== "clear"
  );
}

export function createApplySlashResult(deps: ApplySlashResultDeps) {
  const {
    runSkill,
    runningRef,
    applyPendingChange,
    nextTranscriptId,
    setTranscript,
    agent,
    runSubmittedTurnRef,
    transcriptBatch,
    session,
    broker,
    setPluginStatusNotice,
  } = deps;

  return async (result: SlashResult, text: string): Promise<void> => {
    const persistIfNeeded = async () => {
      if (shouldRecordLocalCommand(result) && result.command && result.feedback) {
        const brokerState = broker.read();
        const commandName = result.command.name;
        const slashIndex = text.indexOf("/" + commandName);
        let args = "";
        if (slashIndex !== -1) {
          args = text.slice(slashIndex + 1 + commandName.length).trim();
        } else {
          const parts = text.trim().split(/\s+/);
          args = parts.slice(1).join(" ").trim();
        }

        await persistLocalCommand({
          session,
          commandName,
          args,
          stdout: result.feedback,
          provider: brokerState.provider,
          model: brokerState.model,
          permissionMode: brokerState.permissionMode,
        });
      }
    };

    if ((result.kind === "skill" || result.kind === "workflow") && result.command) {
      void runSkill(result.command.name, text.slice(result.command.name.length + 1).trim(), text);
      return;
    }
    if (result.pendingChange) {
      const change = result.pendingChange;
      const isRunning = runningRef.current;
      // Everything applies immediately, never queued. effort/model/fast/ultracode
      // land on the running turn's next request (every request re-reads broker
      // state); a goal's meta message is pushed onto the injection queue, drained
      // at the next mid-turn boundary (or the next turn start when idle).
      applyPendingChange(change);
      await persistIfNeeded();
      const id = nextTranscriptId("slash_bullet");
      setTranscript((t) => [
        ...t,
        {
          id,
          kind: "compact_done",
          text: result.feedback ?? "",
          muted: true,
        },
      ]);
      if (!isRunning && change.kind === "set_goal" && change.metaMessage) {
        void runSubmittedTurnRef.current("", { suppressUserTranscript: true });
      }
      return;
    }
    await persistIfNeeded();
    if (result.contextUsage && result.command?.name === "context") {
      const userId = nextTranscriptId("user");
      const usage = result.contextUsage;
      setTranscript((t) => [
        ...t,
        { id: userId, kind: "user", text: "/context", contextUsage: usage },
      ]);
    } else if (result.feedback) {
      if (result.kind === "unknown") {
        const id = nextTranscriptId("slash_err");
        setTranscript((t) => [...t, { id, kind: "slash_error", text: result.feedback ?? "" }]);
      } else if (result.command?.name === "clear") {
        const userId = nextTranscriptId("user");
        setTranscript([
          {
            id: userId,
            kind: "user",
            text: "/clear",
            anchor: result.feedback ?? "",
          },
        ]);
        transcriptBatch.flushNow();
      } else if (result.command?.name === "goal") {
        const userId = nextTranscriptId("user");
        setTranscript((t) => [...t, { id: userId, kind: "user", text: result.feedback ?? "" }]);
      } else if (
        result.command?.name === "plan" ||
        result.command?.name === "fast" ||
        result.command?.name === "effort" ||
        result.command?.name === "copy" ||
        result.command?.name === "model"
      ) {
        const id = nextTranscriptId("slash_bullet");
        setTranscript((t) => [
          ...t,
          {
            id,
            kind: "compact_done",
            text: result.feedback ?? "",
            muted: true,
          },
        ]);
      } else if (result.command?.name === "reload") {
        const userId = nextTranscriptId("user");
        const outId = nextTranscriptId("cmd_out");
        setTranscript((t) => [
          ...t,
          { id: userId, kind: "user", text: "/reload" },
          { id: outId, kind: "command_output", text: result.feedback ?? "" },
        ]);
      } else if (result.command?.name === "plugins") {
        const userId = nextTranscriptId("user");
        const outputId = nextTranscriptId("cmd_out");
        submitPluginNotice("Plugins changed. Run /reload to activate.");
        setPluginStatusNotice?.(null);
        setTranscript((t) => {
          const last = t[t.length - 1];
          const withCommand =
            last?.kind === "user" && last.text === "/plugins"
              ? [...t]
              : [...t, { id: userId, kind: "user" as const, text: "/plugins" }];
          return [
            ...withCommand,
            { id: outputId, kind: "command_output", text: result.feedback ?? "" },
          ];
        });
      } else {
        const id = nextTranscriptId("sys");
        setTranscript((t) => [...t, { id, kind: "system", text: result.feedback ?? "" }]);
      }
    }
    if (result.goalEvent) {
      const ev = result.goalEvent;
      await appendHookEventRecord(session, {
        type: "hook_event",
        ts: nowIso(),
        kind: ev.kind,
        payload: {
          condition: ev.condition,
          ...(ev.kind === "goal_set" ? { setAt: ev.setAt } : {}),
        },
      });
      if (ev.kind === "goal_cleared") {
        await appendRecord(session, {
          type: "attachment",
          ts: nowIso(),
          attachment: {
            type: "goal_status",
            condition: ev.condition,
            cleared: true,
          },
        });
      }
    }
    if (result.shouldQuery && !runningRef.current) {
      await runSubmittedTurnRef.current(text, { suppressUserTranscript: true });
    }
  };
}

export function createRecordPanelCommit(
  applySlashResult: (result: SlashResult, text: string) => Promise<void>,
) {
  return (commandName: string, feedback: string): void => {
    const command = CATALOG.find((c) => c.name === commandName);
    if (!command || !feedback) return;
    void applySlashResult({ kind: "toggle", command, feedback }, `/${command.name}`);
  };
}
