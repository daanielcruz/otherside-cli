import type { MutableRefObject } from "react";
import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import { dispatchSkillFork } from "@/engine/background/subagents/dispatcher.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { resolvePermission } from "@/engine/queue/runtime/permission-resolution.ts";
import type { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import type { TurnLifecycle } from "@/engine/queue/runtime/turn/lifecycle.ts";
import type { Session } from "@/engine/session/index.ts";
import { appendRecord, nowIso, revokeLastUnansweredUserMessage } from "@/engine/session/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { get as getSkill } from "@/engine/skills/registry.ts";
import { renderSkillBody } from "@/engine/tools/builtins/skill.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { BrokerHandle, RequestContext } from "@/kernel/std/types/request.ts";

export interface RunSkillDeps {
  session: Session;
  broker: BrokerHandle;
  agent: Agent;
  setTranscript: (
    value: TranscriptEntry[] | ((prev: readonly TranscriptEntry[]) => TranscriptEntry[]),
  ) => void;
  skillAbortRef: MutableRefObject<AbortController | null>;
  turnGuard: TurnGuard;
  runSubmittedTurnRef: MutableRefObject<
    (text: string, opts?: { additionalContext?: string[] }) => Promise<void>
  >;
  requestBackgroundResumeRef: MutableRefObject<() => void>;
  nextTranscriptId: (prefix: string) => string;
  routeForkEvent: (event: ForkEvent) => void;
  turnLifecycle: TurnLifecycle;
}

export type RunSkillFn = (skillName: string, args: string, slashText: string) => Promise<void>;

export function createRunSkill(deps: RunSkillDeps): RunSkillFn {
  const {
    session,
    broker,
    agent,
    setTranscript,
    skillAbortRef,
    turnGuard,
    runSubmittedTurnRef,
    requestBackgroundResumeRef,
    nextTranscriptId,
    routeForkEvent,
    turnLifecycle,
  } = deps;

  return async function runSkill(
    skillName: string,
    args: string,
    slashText: string,
  ): Promise<void> {
    const skill = getSkill(skillName);
    if (!skill) {
      const id = nextTranscriptId("sys");
      setTranscript((t) => [
        ...t,
        {
          id,
          kind: "system",
          text: `unknown skill: ${skillName}`,
          isError: true,
        },
      ]);
      return;
    }
    if (skill.context !== "fork") {
      const body = renderSkillBody(skill.body);
      const argsBlock = args.length > 0 ? `<command-args>${args}</command-args>\n` : "";
      const content = `<command-name>${skillName}</command-name>\n${argsBlock}${body}`;
      await runSubmittedTurnRef.current(slashText, { additionalContext: [content] });
      return;
    }

    const state = broker.read();
    const userId = nextTranscriptId("u");
    session.append("user_input", { text: slashText });
    await appendRecord(session, {
      type: "user_message",
      ts: nowIso(),
      content: slashText,
      provider: state.provider,
      model: state.model,
    });
    setTranscript((t) => [...t, { id: userId, kind: "user", text: slashText }]);

    const skillAbort = new AbortController();
    skillAbortRef.current = skillAbort;

    const ctx: RequestContext = {
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      permissionMode: state.permissionMode,
      sessionId: session.id,
      // The skill fork attributes its file mutations to this turn directly,
      // instead of arming the session-global turn (which races the dispatch loop).
      rewindTurnId: userId,
      cwd: session.cwd,
      broker,
      eventSink: (event: ForkEvent) => routeForkEvent(event),
      abortSignal: skillAbort.signal,
    };

    const body = renderSkillBody(skill.body);

    const skillPermissionResolver: PermissionResolver = (toolCall) =>
      resolvePermission(
        {
          agentDeps: agent.deps,
          injections: agent.injections,
          sessionAllowedToolPatterns: agent.sessionAllowedToolPatterns,
        },
        toolCall,
        skillAbort.signal,
      );

    turnLifecycle.beginTurn("skill", { startedAt: Date.now() });
    // The skill is a first-class turn in the guard: begin() inside the try so the
    // finally always settles it, and a cancel (abort) during the skill bumps the
    // generation so settle() returns false → wasCancelled, skipping auto-resume.
    // Stays null if begin() reports a turn already live (the submit gate prevents
    // that today) — never settle a generation this skill does not own.
    let skillGen: number | null = null;
    try {
      skillGen = turnGuard.begin();
      const result = await dispatchSkillFork({
        ctx,
        name: skill.name,
        body,
        prompt: args.length > 0 ? args : `Run the ${skill.name} skill.`,
        permissionResolver: skillPermissionResolver,
      });
      if (result.output.length > 0 && !skillAbort.signal.aborted) {
        await appendRecord(session, {
          type: "assistant_message",
          ts: nowIso(),
          content: result.output,
          provider: state.provider,
          model: state.model,
        });
      }
    } catch (err) {
      if (skillAbort.signal.aborted) {
        revokeLastUnansweredUserMessage(session);
      } else {
        const id = nextTranscriptId("err");
        const msg = err instanceof Error ? err.message : String(err);
        setTranscript((t) => [
          ...t,
          { id, kind: "system", text: `skill error: ${msg}`, isError: true },
        ]);
      }
    } finally {
      if (skillAbortRef.current === skillAbort) skillAbortRef.current = null;
      turnLifecycle.endTurn("skill");
      const wasCancelled = skillGen !== null && !turnGuard.settle(skillGen);
      if (!wasCancelled) requestBackgroundResumeRef.current();
    }
  };
}
