import { currentSpawnedAgentScope } from "@/engine/agents/agent-context.ts";
import { defaultEffortForModel, effortLevelsForModel } from "@/engine/model/catalog.ts";
import { resolveModelPin } from "@/engine/model/facts/model-pin.ts";
import { ask as askPermission, FORK_ROUTE_PERMISSION_TOOL } from "@/kernel/channels/permission.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isRecord, trimmedStringOrUndefined } from "@/kernel/std/value-guards.ts";

// Every boundary that carries a route carries the pair. A bare model string is
// never a route here: the provider that owns the model is part of the value.
export interface ForkRoute {
  provider: ProviderId;
  model: string;
}

export interface RequestedForkRoute {
  provider: string;
  model: string;
}

export type ForkRouteRequestParse =
  | { ok: true; route: RequestedForkRoute | undefined }
  | { ok: false; error: string };

export type ForkSpawnRouteAuthorization =
  | { ok: true; ctx: RequestContext; route?: ForkRoute }
  | { ok: false; error: string };

// Classification only: `switch` means a genuine route change was asked for and
// still owes the user an approval prompt, which the caller raises.
export type ForkRouteSwitchDecision =
  | { kind: "inherit" }
  | { kind: "noop"; warning: string }
  | { kind: "rejected"; error: string }
  | { kind: "switch"; route: ForkRoute };

const PAIR_REQUIRED_ERROR =
  "InputValidationError: a route is a {provider, model} pair — pass `provider` and `model` together, or omit both to inherit the session route.";

export function formatForkRoute(route: ForkRoute | RequestedForkRoute): string {
  return `${route.provider}/${route.model}`;
}

export function sessionForkRoute(ctx: Pick<RequestContext, "provider" | "model">): ForkRoute {
  return { provider: ctx.provider, model: ctx.model };
}

export function multiModelForkEnabled(ctx: Pick<RequestContext, "multiModelForkEnabled">): boolean {
  return ctx.multiModelForkEnabled === true;
}

export function sameForkRoute(
  left: ForkRoute | RequestedForkRoute,
  right: ForkRoute | RequestedForkRoute,
): boolean {
  return left.provider === right.provider && left.model === right.model;
}

export function forkRouteCostWarning(
  requested: ForkRoute | RequestedForkRoute,
  session: ForkRoute,
): string {
  return `fork will run ${formatForkRoute(requested)} while the session runs ${formatForkRoute(session)} — separate quota/cost`;
}

export function multiModelForkDisabledError(current: ForkRoute): string {
  return `MultiModelForkDisabled: the "Multi-model fork" setting is off, so every agent runs ${formatForkRoute(current)}. Drop the provider/model pair and the agent keeps that route. Do not retry with a route: only the user can turn the setting on, in /config.`;
}

export function forkRouteDeniedError(requested: ForkRoute, current: ForkRoute): string {
  return `Permission denied: the user declined running this agent on ${formatForkRoute(requested)} instead of ${formatForkRoute(current)}. Nothing ran on the requested route. Drop the provider/model pair to stay on ${formatForkRoute(current)}.`;
}

export function forkRouteUnattendedError(requested: ForkRoute, current: ForkRoute): string {
  return `Permission unavailable: running this agent on ${formatForkRoute(requested)} instead of ${formatForkRoute(current)} needs interactive approval, and this run has no one to answer it. Drop the provider/model pair to stay on ${formatForkRoute(current)}.`;
}

export function forkRouteNoopWarning(current: ForkRoute, subject?: string): string {
  const who = subject === undefined ? "this agent" : `agent ${subject}`;
  return `routing ignored: ${who} already runs ${formatForkRoute(current)}. Omit \`routing\` unless the agent must move to a different provider/model.`;
}

// Wire input for a spawn: two sibling string fields that must arrive together.
export function forkRouteFromSpawnInput(input: {
  provider?: string | undefined;
  model?: string | undefined;
}): ForkRouteRequestParse {
  const provider = trimmedStringOrUndefined(input.provider);
  const model = trimmedStringOrUndefined(input.model);
  if (provider === undefined && model === undefined) return { ok: true, route: undefined };
  if (provider === undefined || model === undefined)
    return { ok: false, error: PAIR_REQUIRED_ERROR };
  return { ok: true, route: { provider, model } };
}

// Wire input for a resume: one optional object that already models the pair.
export function forkRouteFromRoutingField(raw: unknown): ForkRouteRequestParse {
  if (raw === undefined || raw === null) return { ok: true, route: undefined };
  if (!isRecord(raw)) return { ok: false, error: PAIR_REQUIRED_ERROR };
  return forkRouteFromSpawnInput({
    provider: typeof raw.provider === "string" ? raw.provider : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
  });
}

// Explicit pins are literal: the pair either exists in the available catalog or
// the request fails with that catalog error. Nothing is substituted.
export function resolveForkRoutePin(
  requested: RequestedForkRoute,
  ctx: Pick<RequestContext, "provider" | "orchestrationMode">,
): { ok: true; route: ForkRoute } | { ok: false; error: string } {
  const pin = resolveModelPin(
    requested.provider,
    requested.model,
    ctx.provider,
    ctx.orchestrationMode ?? "disabled",
  );
  if (!pin.ok) return { ok: false, error: pin.error };
  return { ok: true, route: { provider: pin.resolution.provider, model: pin.resolution.model } };
}

export function withPinnedForkRoute(ctx: RequestContext, route: ForkRoute): RequestContext {
  const next: RequestContext = { ...ctx, provider: route.provider, model: route.model };
  if (next.effort !== null && !effortLevelsForModel(route).includes(next.effort)) {
    next.effort = defaultEffortForModel(route);
  }
  return next;
}

// Same rule the tool permission path applies: a headless run, or a detached
// agent with no live dialog bound, has nobody to answer the modal.
function canRaiseRoutePrompt(): boolean {
  const runtime = getRuntimeKind();
  if (runtime === "print") return false;
  if (runtime === "interactive") return true;
  return currentSpawnedAgentScope()?.shouldAvoidPermissionPrompts !== true;
}

export async function askForkRouteApproval(args: {
  requested: ForkRoute;
  session: ForkRoute;
  subject?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!canRaiseRoutePrompt()) {
    return { ok: false, error: forkRouteUnattendedError(args.requested, args.session) };
  }
  const warning = forkRouteCostWarning(args.requested, args.session);
  const result = await askPermission(
    {
      toolName: FORK_ROUTE_PERMISSION_TOOL,
      argsPreview: `${formatForkRoute(args.requested)} (session: ${formatForkRoute(args.session)})`,
      rule: null,
      input: {
        requested_provider: args.requested.provider,
        requested_model: args.requested.model,
        session_provider: args.session.provider,
        session_model: args.session.model,
        warning,
        ...(args.subject !== undefined ? { agent: args.subject } : {}),
      },
    },
    args.signal,
  );
  if (result.decision === "allow") return { ok: true };
  return { ok: false, error: forkRouteDeniedError(args.requested, args.session) };
}

/**
 * Spawn gate. Returns the context the fork must run on: the caller's own when
 * no route was requested (or the requested pair resolves to the session route),
 * a pinned one once the user approves the cost prompt.
 */
export async function authorizeForkSpawnRoute(
  requested: RequestedForkRoute | undefined,
  ctx: RequestContext,
): Promise<ForkSpawnRouteAuthorization> {
  if (requested === undefined) return { ok: true, ctx };
  const session = sessionForkRoute(ctx);
  if (sameForkRoute(requested, session)) return { ok: true, ctx };
  if (!multiModelForkEnabled(ctx)) {
    return { ok: false, error: multiModelForkDisabledError(session) };
  }
  const pinned = resolveForkRoutePin(requested, ctx);
  if (!pinned.ok) return pinned;
  if (sameForkRoute(pinned.route, session)) return { ok: true, ctx };
  const approval = await askForkRouteApproval({
    requested: pinned.route,
    session,
    ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
  });
  if (!approval.ok) return approval;
  return { ok: true, ctx: withPinnedForkRoute(ctx, pinned.route), route: pinned.route };
}

/**
 * Resume gate, split from its prompt so the whole classification (no field,
 * disabled setting, same-pair no-op, catalog miss) stays synchronous: the
 * caller decides whether a genuine switch is even reachable before prompting.
 */
export function classifyForkRouteSwitch(
  requested: RequestedForkRoute | undefined,
  current: ForkRoute,
  ctx: Pick<RequestContext, "provider" | "orchestrationMode" | "multiModelForkEnabled">,
  subject?: string,
): ForkRouteSwitchDecision {
  if (requested === undefined) return { kind: "inherit" };
  if (sameForkRoute(requested, current)) {
    return { kind: "noop", warning: forkRouteNoopWarning(current, subject) };
  }
  if (!multiModelForkEnabled(ctx)) {
    return { kind: "rejected", error: multiModelForkDisabledError(current) };
  }
  const pinned = resolveForkRoutePin(requested, ctx);
  if (!pinned.ok) return { kind: "rejected", error: pinned.error };
  if (sameForkRoute(pinned.route, current)) {
    return { kind: "noop", warning: forkRouteNoopWarning(current, subject) };
  }
  return { kind: "switch", route: pinned.route };
}
