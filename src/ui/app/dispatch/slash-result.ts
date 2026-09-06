import { CATALOG, type PendingChange, type SlashResult } from "@/commands/index.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { persistLocalCommand, type Session } from "@/engine/session/index.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { submitPluginNotice } from "@/store/app-store/right-region-notices.ts";
import type { TranscriptWrite } from "@/ui/transcript/types";

type RunSubmittedTurn = (
  text: string,
  opts?: { suppressUserTranscript?: boolean },
) => Promise<void>;

export interface ApplySlashResultDeps {
  /**
   * Runs a command that stands in for a prompt. It owns the whole shape of that
   * run — an inline command becomes a turn, a `context: fork` skill becomes a
   * subagent — so this surface hands the command over and stops there.
   */
  runSkill: (name: string, args: string, raw: string) => Promise<void>;
  runningRef: { current: boolean };
  applyPendingChange: (change: PendingChange) => void;
  nextTranscriptId: (prefix: string) => string;
  setTranscript: (value: TranscriptWrite) => void;
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

/** The words typed after `/name`, whether the line names the command or an alias. */
export function commandArgsFromText(commandName: string, text: string): string {
  const slashIndex = text.indexOf("/" + commandName);
  if (slashIndex !== -1) return text.slice(slashIndex + 1 + commandName.length).trim();
  const parts = text.trim().split(/\s+/);
  return parts.slice(1).join(" ").trim();
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
        const args = commandArgsFromText(commandName, text);

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

    // A command that stands in for a prompt never becomes a turn here: its
    // frontmatter decides whether it runs inline or as a fork, and only the
    // runner reads that. Falling through would make every one of them a main
    // turn and silently discard the `context: fork` declaration.
    if ((result.kind === "skill" || result.kind === "workflow") && result.command) {
      const commandName = result.command.name;
      await runSkill(commandName, commandArgsFromText(commandName, text), text.trim());
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
      } else if (result.command?.name === "fork") {
        const userId = nextTranscriptId("user");
        const outputId = nextTranscriptId("cmd_out");
        setTranscript((t) => [
          ...t,
          { id: userId, kind: "user", text: text.trim() },
          { id: outputId, kind: "command_output", text: result.feedback ?? "" },
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
    if (result.shouldQuery && !runningRef.current) {
      // A command that resolved its own words sends those, and they are shown
      // the way a typed message is — what goes out under the reader's name has
      // to be readable back. Without a resolved text the typed line IS the turn,
      // and it is already on screen, so echoing it again would double it.
      const resolved = result.queryText;
      if (resolved === undefined) {
        await runSubmittedTurnRef.current(text, { suppressUserTranscript: true });
        return;
      }
      await runSubmittedTurnRef.current(resolved);
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
