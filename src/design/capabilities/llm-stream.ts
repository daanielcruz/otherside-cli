import {
  fail,
  notify,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  success,
} from "@/design/bridge/envelope.ts";
import {
  generateAndSaveDesignTitle,
  isPlaceholderDesignTitle,
} from "@/design/capabilities/design-title.ts";
import { buildCanvasContext, resolveSnapshot } from "@/design/capabilities/stream-context.ts";
import {
  completeSnapshot,
  designTurnFailureMessage,
  emitForkEvent,
  setSnapshotMessages,
} from "@/design/capabilities/stream-events.ts";
import {
  messageText,
  parseImageDataUri,
  parseLlmStreamInput,
  visibleMessages,
} from "@/design/capabilities/stream-input.ts";
import { makeBridgePermissionResolver } from "@/design/capabilities/stream-permissions.ts";
import { buildDesignDirectives, resolveDesignToolset } from "@/design/capabilities/stream-tools.ts";
import { runVerificationRounds } from "@/design/capabilities/verification-rounds.ts";
import { clearVerificationQueue } from "@/design/capabilities/verification-tools.ts";
import { registerDesignFork, unregisterDesignFork } from "@/design/fork-context.ts";
import { DESIGN_FORK_BODY } from "@/design/harness.ts";
import { buildDesignHistory } from "@/design/history.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { DESIGN_STREAM_TOOL_INPUTS, DesignStreamPreview } from "@/design/stream-preview.ts";
import {
  beginDesignTextSegments,
  clearDesignTextSegments,
  clearDesignTurnIndex,
  currentDesignTextSegment,
  setDesignTurnIndex,
} from "@/design/tool-cards.ts";
import {
  drainDesignSteers,
  registerDesignTurn,
  steerDesignTurn,
  unregisterDesignTurn,
} from "@/design/turns.ts";
import type { DesignCapability, RpcContext } from "@/design/types.ts";
import { writeDebugError } from "@/devtools/output.ts";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import { canSendNatively } from "@/engine/model/capabilities-runtime.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { describeImageViaProvider } from "@/engine/tools/builtins/parse-image.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { DrainedQueuedMessage, ForkEvent } from "@/kernel/std/types/events.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

async function handle(params: unknown, ctx: RpcContext, id: number | string | null): Promise<void> {
  const parsed = parseLlmStreamInput(params, ctx.activeDesignId ?? "");
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  // resolveSnapshot (not a bare Map check) so a design that only exists on disk
  // after a CLI restart is seeded into memory instead of rejected.
  if (!resolveSnapshot(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown designId"));
    return;
  }

  const lastUserMsg = [...parsed.messages].reverse().find((message) => message.role === "user");
  const lastUserText = lastUserMsg ? messageText(lastUserMsg) : "";
  if (steerDesignTurn(parsed.designId, lastUserText)) {
    setSnapshotMessages(ctx, parsed);
    ctx.send(success(id, { steered: true }));
    return;
  }

  const broker = ctx.broker.read();
  const streamId = typeof id === "number" ? id : Date.now();
  const abortController = new AbortController();
  const streamPreview = new DesignStreamPreview(ctx, parsed.designId);
  let activeForkId: string | null = null;
  setSnapshotMessages(ctx, parsed);
  registerDesignTurn(parsed.designId, abortController);
  // A stale queue from an aborted turn must not leak verifier runs into this one.
  clearVerificationQueue(parsed.designId);
  // 0-based index of the user-turn now starting: prior user messages precede
  // the current one in params.messages, so it's the user count minus one. Tool
  // cards recorded during this run and the closing assistant message are all
  // stamped with it so history replay can put them back in the right turn.
  const turnIndex = Math.max(
    0,
    visibleMessages(parsed.messages).filter((message) => message.role === "user").length - 1,
  );
  setDesignTurnIndex(parsed.designId, turnIndex);
  beginDesignTextSegments(parsed.designId);
  ctx.emit(notify("$/stream", { id: streamId, event: "start" }));
  try {
    const codebaseRoot = parsed.codebase === true ? ctx.codebaseRoot : null;
    const codebaseAttached = codebaseRoot !== null;

    const snapshot = resolveSnapshot(ctx, parsed.designId);
    const targetProvider = (
      snapshot && snapshot.provider !== undefined ? snapshot.provider : broker.provider
    ) as ProviderId;
    const targetModel = snapshot && snapshot.model !== undefined ? snapshot.model : broker.model;
    const targetEffort = (
      snapshot && snapshot.effort !== undefined ? snapshot.effort : broker.effort
    ) as EffortLevel | null;

    const toolset = await resolveDesignToolset(targetProvider, codebaseAttached);
    const requestContext = makeRequestContext(ctx.agent.deps);
    requestContext.cwd = codebaseRoot ?? ctx.cwd;
    requestContext.sessionId = ctx.session.id;
    requestContext.permissionMode = "default";
    requestContext.permissionModeIsFixed = true;
    requestContext.abortSignal = abortController.signal;
    requestContext.provider = targetProvider;
    requestContext.model = targetModel;
    requestContext.effort = targetEffort;

    if (snapshot && isPlaceholderDesignTitle(snapshot.title)) {
      const firstUserMsg = parsed.messages.find((message) => message.role === "user");
      if (firstUserMsg) {
        const userPrompt = messageText(firstUserMsg);
        generateAndSaveDesignTitle(ctx, requestContext, parsed.designId, userPrompt).catch(
          () => {},
        );
      }
    }

    const resolver = makeBridgePermissionResolver(
      ctx,
      abortController.signal,
      codebaseRoot,
      toolset.allowSet,
    );
    const result = await runWithPermissionResolver(resolver, async () => {
      const messages = visibleMessages(parsed.messages);
      if (parsed.mentionedElements && parsed.mentionedElements.length > 0) {
        const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
        if (lastUserMessage) {
          let suffix = "";
          for (const element of parsed.mentionedElements) {
            suffix += `\n\n<mentioned-element>\nid: ${element.id}\n`;
            if (element.tag) {
              suffix += `tag: ${element.tag}\n`;
            }
            if (element.path) {
              suffix += `dom: ${element.path}\n`;
            }
            suffix += "</mentioned-element>";
          }
          lastUserMessage.content += suffix;
        }
      }
      const canvasContext = buildCanvasContext(resolveSnapshot(ctx, parsed.designId));
      const directives = buildDesignDirectives({
        codebaseAttached,
        medium: parsed.medium,
        activeSkills: parsed.activeSkills,
        targetScreen: parsed.targetScreen,
      });
      // Split the transcript: everything before the last user message replays
      // structurally (with each turn's persisted tool_use/tool_result blocks)
      // as initialMessages; only the current user message rides the prompt,
      // composed with canvas context and directives exactly as before.
      let currentIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
          currentIndex = index;
          break;
        }
      }
      const priorMessages =
        currentIndex >= 0 ? messages.slice(0, currentIndex) : messages.slice(0, -1);
      const currentText =
        (currentIndex >= 0
          ? messages[currentIndex]?.content
          : messages[messages.length - 1]?.content) ?? "";
      const history = buildDesignHistory(resolveSnapshot(ctx, parsed.designId), priorMessages);
      const promptText = `${canvasContext}${directives}${currentText}`;
      const withHistory = (blocks: Message["content"]): Message[] => [
        ...history,
        { role: "user", content: blocks },
      ];
      const images = (parsed.attachments ?? [])
        .map((attachment) => parseImageDataUri(attachment.data))
        .filter((image): image is { mediaType: ImageMediaType; data: string } => image !== null);
      const toDrainedMessage = (text: string): DrainedQueuedMessage => ({
        text,
        blocks: [{ type: "text", text }],
      });
      const sharedSpec = {
        ctx: requestContext,
        name: "design",
        body: DESIGN_FORK_BODY,
        allowSet: toolset.allowSet,
        // Read/Bash already live in scopedTools when codebase is attached.
        deferredAllow: new Set<string>(),
        description: "Design canvas turn",
        extraDeclarations: toolset.declarations,
        scopedTools: toolset.scopedTools,
        pendingUserInputDrainer: () => drainDesignSteers(parsed.designId).map(toDrainedMessage),
        streamToolInputFor: DESIGN_STREAM_TOOL_INPUTS,
        sink: (event: ForkEvent) => {
          streamPreview.handle(event);
          if (event.kind === "fork_start") {
            activeForkId = event.forkId;
            registerDesignFork(event.forkId, {
              designId: parsed.designId,
              cwd: ctx.cwd,
              snapshots: ctx.snapshots,
              emit: ctx.emit,
            });
          }
          emitForkEvent(ctx, streamId, event, parsed.designId);
        },
      };
      if (images.length > 0 && canSendNatively(targetProvider, targetModel)) {
        const initialMessages = withHistory([
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mediaType,
              data: image.data,
            },
          })),
          { type: "text" as const, text: promptText },
        ]);
        return runForkLoopExternal({ ...sharedSpec, prompt: promptText, initialMessages });
      }
      if (images.length > 0) {
        const descriptions: string[] = [];
        for (const image of images) {
          const described = await describeImageViaProvider(
            requestContext,
            { data: image.data, mediaType: image.mediaType },
            "Describe this attached image in detail so it can inform a UI/design task.",
          );
          if ("text" in described) descriptions.push(described.text);
        }
        const finalPrompt =
          descriptions.length > 0
            ? `${promptText}\n\nAttached image(s):\n${descriptions.join("\n\n")}`
            : promptText;
        if (history.length === 0) {
          return runForkLoopExternal({ ...sharedSpec, prompt: finalPrompt });
        }
        return runForkLoopExternal({
          ...sharedSpec,
          prompt: finalPrompt,
          initialMessages: withHistory([{ type: "text", text: finalPrompt }]),
        });
      }
      // No prior turns: keep the original prompt-only spec so the first turn's
      // provider-specific user-block composition stays exactly as before.
      if (history.length === 0) {
        return runForkLoopExternal({ ...sharedSpec, prompt: promptText });
      }
      return runForkLoopExternal({
        ...sharedSpec,
        prompt: promptText,
        initialMessages: withHistory([{ type: "text", text: promptText }]),
      });
    });
    if (result.isError) {
      writeDebugError("design fork failed", result.output);
      ctx.emit(notify("$/stream", { id: streamId, event: "end" }));
      ctx.send(
        fail(id, RPC_INTERNAL_ERROR, designTurnFailureMessage(result, targetProvider, targetModel)),
      );
      return;
    }
    completeSnapshot(ctx, parsed.designId, result.output, turnIndex);
    ctx.emit(notify("$/stream", { id: streamId, event: "end" }));
    ctx.send(
      success(id, {
        text: result.output,
        provider: targetProvider,
        model: targetModel,
        // The final text is the last segment; the completion must update THAT
        // bubble, not segment 0's (which holds pre-tool prose). Matches the live
        // $/delta id so the intro bubble survives the turn's completion.
        segment: currentDesignTextSegment(parsed.designId),
        usage:
          result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : undefined,
      }),
    );
    try {
      // Screens the model queued via ready_for_verification get their background
      // verifier now; needs_work findings wake the design fork, bounded rounds.
      await runWithPermissionResolver(resolver, () =>
        runVerificationRounds({
          ctx,
          designId: parsed.designId,
          streamId,
          requestContext,
          toolset,
          turnIndex,
        }),
      );
    } catch {
      // Best-effort: the RPC already responded and the stream ended, so a
      // failed verification pass has no client channel — never fail the turn.
    }
  } catch (error) {
    writeDebugError("design stream failed", error);
    ctx.emit(notify("$/stream", { id: streamId, event: "end" }));
    ctx.send(fail(id, RPC_INTERNAL_ERROR, "stream failed"));
  } finally {
    streamPreview.rollbackAll();
    clearDesignTurnIndex(parsed.designId);
    clearDesignTextSegments(parsed.designId);
    clearVerificationQueue(parsed.designId);
    unregisterDesignTurn(parsed.designId, abortController);
    if (activeForkId) unregisterDesignFork(activeForkId);
  }
}

export { executeOneShotCompletion } from "@/design/capabilities/one-shot-completion.ts";
export { designTurnFailureMessage } from "@/design/capabilities/stream-events.ts";
export { snapshotMessages } from "@/design/capabilities/stream-input.ts";
export {
  clearDesignSessionAllows,
  isReadOnlyCommand,
  makeBridgePermissionResolver,
} from "@/design/capabilities/stream-permissions.ts";

export const LlmStreamCapability: DesignCapability = {
  name: "llm.stream",
  rpcMethod: {
    method: "llm.stream",
    handler: handle,
  },
};
