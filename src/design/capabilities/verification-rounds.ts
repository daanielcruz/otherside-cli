import { buildCanvasContext, resolveSnapshot } from "@/design/capabilities/stream-context.ts";
import { completeSnapshot, emitForkEvent } from "@/design/capabilities/stream-events.ts";
import type { DesignToolset } from "@/design/capabilities/stream-tools.ts";
import { registerDesignFork, unregisterDesignFork } from "@/design/fork-context.ts";
import { DESIGN_FORK_BODY } from "@/design/harness.ts";
import { buildDesignHistory } from "@/design/history.ts";
import { DESIGN_STREAM_TOOL_INPUTS, DesignStreamPreview } from "@/design/stream-preview.ts";
import { drainDesignSteerMessages, setDesignTurnSteerable } from "@/design/turns.ts";
import type { RpcContext } from "@/design/types.ts";
import { drainVerificationQueue } from "@/design/verifier.ts";
import { writeDebugError } from "@/devtools/output.ts";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const MAX_VERIFICATION_ROUNDS = 3;
const NEEDS_WORK_STREAK_NUDGE = 3;

export async function runVerificationRounds(args: {
  ctx: RpcContext;
  designId: string;
  streamId: number;
  requestContext: RequestContext;
  turnController: AbortController;
  toolset: DesignToolset;
  turnIndex: number;
}): Promise<void> {
  const { ctx, designId, streamId, requestContext, turnController, toolset, turnIndex } = args;
  const turnSignal = requestContext.abortSignal;
  const needsWorkStreak = new Map<string, number>();
  // One extra pass beyond the repair budget: the last repair's fixes still get
  // verified (their verdict lands on the timeline) even though no further
  // repair round is spent on them.
  for (let round = 0; round <= MAX_VERIFICATION_ROUNDS; round += 1) {
    if (turnSignal?.aborted) return;
    const findings = await drainVerificationQueue({ ctx, designId, requestContext });
    // The verifier is the long phase: a turn superseded meanwhile owns the
    // design now, and its stale findings must not start a repair fork.
    if (turnSignal?.aborted || findings.length === 0) return;
    if (round === MAX_VERIFICATION_ROUNDS) return;
    for (const finding of findings) {
      needsWorkStreak.set(finding.path, (needsWorkStreak.get(finding.path) ?? 0) + 1);
    }
    const blocks = findings.map(
      (finding) =>
        `<verifier-result verdict="needs_work">\n${finding.description}\n</verifier-result>`,
    );
    const stuck = findings.some(
      (finding) => (needsWorkStreak.get(finding.path) ?? 0) >= NEEDS_WORK_STREAK_NUDGE,
    );
    const nudge = stuck
      ? "\n\nThis file has come back needs_work several times in a row — incremental tweaks are not converging. State the root cause in one sentence, make ONE decisive edit targeting that cause, and do not tweak the same numeric property again."
      : "";
    const snapshot = resolveSnapshot(ctx, designId);
    const history = buildDesignHistory(
      snapshot,
      (snapshot?.messages ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );
    const prompt = `${buildCanvasContext(snapshot)}${blocks.join("\n\n")}${nudge}`;
    const streamPreview = new DesignStreamPreview(ctx, designId);
    let roundForkId: string | null = null;
    const sink = (event: ForkEvent): void => {
      streamPreview.handle(event);
      if (event.kind === "fork_start") {
        roundForkId = event.forkId;
        registerDesignFork(event.forkId, {
          designId,
          cwd: ctx.cwd,
          snapshots: ctx.snapshots,
          emit: ctx.emit,
        });
        return;
      }
      // The turn's RPC already responded and its stream ended — tool and error
      // events still flow as notifications, but text deltas have no channel.
      if (event.kind === "fork_text_delta") return;
      emitForkEvent(ctx, streamId, event, designId);
    };
    // A repair fork drains steers like the main turn did; between forks a
    // message starts a new turn instead of waiting on a verifier.
    setDesignTurnSteerable(designId, turnController, true);
    try {
      const result = await runForkLoopExternal({
        ctx: requestContext,
        name: "design",
        body: DESIGN_FORK_BODY,
        allowSet: toolset.allowSet,
        deferredAllow: new Set<string>(),
        description: "Design verification follow-up",
        extraDeclarations: toolset.declarations,
        scopedTools: toolset.scopedTools,
        prompt,
        initialMessages: [...history, { role: "user", content: [{ type: "text", text: prompt }] }],
        pendingUserInputDrainer: () => drainDesignSteerMessages(designId),
        streamToolInputFor: DESIGN_STREAM_TOOL_INPUTS,
        sink,
      });
      if (!result.isError && result.output.trim().length > 0) {
        completeSnapshot(ctx, designId, result.output, turnIndex);
      }
    } catch (error) {
      if (!turnSignal?.aborted) writeDebugError("design repair round failed", error);
      return;
    } finally {
      setDesignTurnSteerable(designId, turnController, false);
      streamPreview.rollbackAll();
      if (roundForkId) unregisterDesignFork(roundForkId);
    }
  }
}
