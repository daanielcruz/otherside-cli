import { defaultEffortForModel, effortLevelsForModel } from "@/engine/model/catalog.ts";
import { listEnabledHookEntries } from "@/engine/plugins/registry.ts";
import { attachSessionWorktreeHost } from "@/engine/session/worktree.ts";
import { effectiveOrchestrationMode } from "@/kernel/config/config.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { AgentDeps } from "./turn/types.ts";

export function makeRequestContext(deps: AgentDeps, turnId?: string): RequestContext {
  // Keep the live Session bound so enter/exit can mutate active cwd without process.chdir.
  attachSessionWorktreeHost(deps.session);
  const state = deps.broker.read();
  const wt = deps.session.worktree;
  const ctx: RequestContext = {
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    permissionMode: state.permissionMode,
    orchestrationMode: effectiveOrchestrationMode(deps.config),
    quotaFallbackEnabled: deps.config.quotaFallback ?? true,
    chainOfCommandEnabled: deps.config.chainOfCommand ?? true,
    sessionId: deps.session.id,
    // Active cwd (may be a session worktree path). Transcripts key on storageCwd.
    cwd: deps.session.cwd,
    additionalWorkingDirectories: deps.session.additionalWorkingDirectories,
    broker: deps.broker,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(deps.session.contentReplacementState !== undefined
      ? { contentReplacementState: deps.session.contentReplacementState }
      : {}),
    ...(wt != null
      ? {
          originalCwd: wt.originalCwd,
          worktreeRoot: wt.activePath,
        }
      : {}),
  };
  if (ctx.effort !== null && !effortLevelsForModel(ctx.model, ctx.provider).includes(ctx.effort)) {
    ctx.effort = defaultEffortForModel(ctx.model, ctx.provider);
  }
  ctx.taskHooks = {
    created: [...(deps.config.hooks?.taskCreated ?? []), ...listEnabledHookEntries("taskCreated")],
    completed: [
      ...(deps.config.hooks?.taskCompleted ?? []),
      ...listEnabledHookEntries("taskCompleted"),
    ],
  };
  return ctx;
}
