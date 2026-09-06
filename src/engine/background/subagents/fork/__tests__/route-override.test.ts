import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defaultEffortForModel, effortLevelsForModel } from "@/engine/model/catalog.ts";
import { setCredentialsLoaderForTests } from "@/engine/model/tier/usability.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import { clearProviderCooldowns } from "@/engine/session/usage/provider-health.ts";
import {
  answer,
  clear as clearPermissionQueue,
  FORK_ROUTE_PERMISSION_TOOL,
  type PendingPermission,
  subscribe,
} from "@/kernel/channels/permission.ts";
import { getRuntimeKind, setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import {
  authorizeForkSpawnRoute,
  classifyForkRouteSwitch,
  forkRouteFromRoutingField,
  forkRouteFromSpawnInput,
  withPinnedForkRoute,
} from "../route-override.ts";

registerAllProviders();

const SESSION_PROVIDER = "anthropic";
const SESSION_MODEL = "claude-opus-5";
const OTHER_PROVIDER = "codex";
const OTHER_MODEL = "gpt-5.5";

// Hermetic bundle: only the two providers the pins under test name are
// credentialed, so nothing else can be picked up as a usable route.
const CODEX_AND_ANTHROPIC = (): CredentialsBundle =>
  ({
    codex: { accessToken: "placeholder" },
    anthropic: { accessToken: "placeholder" },
  }) as unknown as CredentialsBundle;

function ctxWith(
  multiModelForkEnabled: boolean | undefined,
  orchestrationMode: OrchestrationMode = "default",
): RequestContext {
  return {
    provider: SESSION_PROVIDER,
    model: SESSION_MODEL,
    effort: null,
    permissionMode: "default",
    orchestrationMode,
    sessionId: "route-override-session",
    cwd: "/workspace/placeholder",
    ...(multiModelForkEnabled !== undefined ? { multiModelForkEnabled } : {}),
  } as RequestContext;
}

// Stands in for the user answering the modal, and records every request that
// reached the channel so the modal's own content can be asserted.
function autoAnswerPermissions(decision: "allow" | "deny"): {
  prompts: PendingPermission[];
  stop: () => void;
} {
  const prompts: PendingPermission[] = [];
  const answered = new Set<string>();
  const stop = subscribe((queue) => {
    for (const pending of queue) {
      if (answered.has(pending.id)) continue;
      answered.add(pending.id);
      prompts.push(pending);
      queueMicrotask(() => {
        answer(pending.id, { decision, updates: [] });
      });
    }
  });
  return { prompts, stop };
}

beforeEach(() => {
  clearPermissionQueue();
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  setCredentialsLoaderForTests(CODEX_AND_ANTHROPIC);
});

afterEach(() => {
  setCredentialsLoaderForTests(null);
  clearPermissionQueue();
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  stopUsageSweepTimerForTests();
});

describe("fork route pairs on the wire", () => {
  it("accepts provider and model only together", () => {
    expect(forkRouteFromSpawnInput({})).toEqual({ ok: true, route: undefined });
    expect(forkRouteFromSpawnInput({ provider: OTHER_PROVIDER, model: OTHER_MODEL })).toEqual({
      ok: true,
      route: { provider: OTHER_PROVIDER, model: OTHER_MODEL },
    });

    const modelOnly = forkRouteFromSpawnInput({ model: OTHER_MODEL });
    expect(modelOnly.ok).toBe(false);
    if (!modelOnly.ok) expect(modelOnly.error).toContain("{provider, model} pair");

    const providerOnly = forkRouteFromSpawnInput({ provider: OTHER_PROVIDER });
    expect(providerOnly.ok).toBe(false);
  });

  it("reads the resume routing field as the same pair", () => {
    expect(forkRouteFromRoutingField(undefined)).toEqual({ ok: true, route: undefined });
    expect(forkRouteFromRoutingField({ provider: OTHER_PROVIDER, model: OTHER_MODEL })).toEqual({
      ok: true,
      route: { provider: OTHER_PROVIDER, model: OTHER_MODEL },
    });
    expect(forkRouteFromRoutingField({ model: OTHER_MODEL }).ok).toBe(false);
    expect(forkRouteFromRoutingField("codex/gpt-5.5").ok).toBe(false);
  });
});

describe("multi-model fork gate on spawn", () => {
  it("rejects a differing pair while the setting is off, without prompting", async () => {
    const { prompts, stop } = autoAnswerPermissions("allow");
    try {
      const result = await authorizeForkSpawnRoute(
        { provider: OTHER_PROVIDER, model: OTHER_MODEL },
        ctxWith(undefined),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("MultiModelForkDisabled");
        expect(result.error).toContain('"Multi-model fork"');
        expect(result.error).toContain("Do not retry with a route");
      }
      expect(prompts).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("treats the session's own pair as an inherit, never a rejection", async () => {
    const { prompts, stop } = autoAnswerPermissions("allow");
    try {
      const ctx = ctxWith(false);
      const result = await authorizeForkSpawnRoute(
        { provider: SESSION_PROVIDER, model: SESSION_MODEL },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ctx.provider).toBe(SESSION_PROVIDER);
        expect(result.ctx.model).toBe(SESSION_MODEL);
        expect(result.route).toBeUndefined();
      }
      expect(prompts).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("leaves a routeless spawn on the session route", async () => {
    const ctx = ctxWith(true);
    const result = await authorizeForkSpawnRoute(undefined, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx).toBe(ctx);
  });
});

describe("permission flow for a differing fork route", () => {
  it.each([
    "default",
    "feudalism",
  ] as const)("raises the unchanged modal and pins the pair on %s approval", async (orchestrationMode) => {
    const { prompts, stop } = autoAnswerPermissions("allow");
    try {
      const result = await authorizeForkSpawnRoute(
        { provider: OTHER_PROVIDER, model: OTHER_MODEL },
        ctxWith(true, orchestrationMode),
      );

      expect(prompts).toHaveLength(1);
      const pending = prompts[0];
      if (!pending) throw new Error("expected a permission request");
      expect(pending.toolName).toBe(FORK_ROUTE_PERMISSION_TOOL);
      expect(pending.rule).toBeNull();
      expect(pending.argsPreview).toContain(`${OTHER_PROVIDER}/${OTHER_MODEL}`);
      expect(pending.argsPreview).toContain(`${SESSION_PROVIDER}/${SESSION_MODEL}`);
      const input = pending.input as Record<string, unknown>;
      expect(input.requested_provider).toBe(OTHER_PROVIDER);
      expect(input.requested_model).toBe(OTHER_MODEL);
      expect(input.session_provider).toBe(SESSION_PROVIDER);
      expect(input.session_model).toBe(SESSION_MODEL);
      expect(input.warning).toBe(
        `fork will run ${OTHER_PROVIDER}/${OTHER_MODEL} while the session runs ${SESSION_PROVIDER}/${SESSION_MODEL} — separate quota/cost`,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ctx.provider).toBe(OTHER_PROVIDER);
        expect(result.ctx.model).toBe(OTHER_MODEL);
        expect(result.route).toEqual({ provider: OTHER_PROVIDER, model: OTHER_MODEL });
      }
    } finally {
      stop();
    }
  });

  it("cancels the spawn on denial and names both routes in the outcome", async () => {
    const { prompts, stop } = autoAnswerPermissions("deny");
    try {
      const result = await authorizeForkSpawnRoute(
        { provider: OTHER_PROVIDER, model: OTHER_MODEL },
        ctxWith(true),
      );
      expect(prompts).toHaveLength(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Permission denied");
        expect(result.error).toContain(`${OTHER_PROVIDER}/${OTHER_MODEL}`);
        expect(result.error).toContain(`${SESSION_PROVIDER}/${SESSION_MODEL}`);
      }
    } finally {
      stop();
    }
  });

  it("refuses instead of waiting when no one can answer the modal", async () => {
    const { prompts, stop } = autoAnswerPermissions("allow");
    const previousRuntime = getRuntimeKind();
    setRuntimeKind("print");
    try {
      const result = await authorizeForkSpawnRoute(
        { provider: OTHER_PROVIDER, model: OTHER_MODEL },
        ctxWith(true),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("needs interactive approval");
      expect(prompts).toHaveLength(0);
    } finally {
      setRuntimeKind(previousRuntime);
      stop();
    }
  });

  it.each([
    "default",
    "feudalism",
  ] as const)("fails an off-catalog pin with no substitution on %s", async (orchestrationMode) => {
    const { prompts, stop } = autoAnswerPermissions("allow");
    try {
      const result = await authorizeForkSpawnRoute(
        { provider: OTHER_PROVIDER, model: "model-that-does-not-exist" },
        ctxWith(true, orchestrationMode),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("model-that-does-not-exist");
        expect(result.error).toContain(`is not available on provider "${OTHER_PROVIDER}"`);
      }
      expect(prompts).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("rejects an unknown provider without substituting the session one", async () => {
    const { prompts, stop } = autoAnswerPermissions("allow");
    try {
      const result = await authorizeForkSpawnRoute(
        { provider: "not-a-provider", model: OTHER_MODEL },
        ctxWith(true),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('unknown provider "not-a-provider"');
      expect(prompts).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

describe("SendMessage route switch classification", () => {
  const current = { provider: SESSION_PROVIDER, model: SESSION_MODEL } as const;

  it("treats the pair the agent already runs as a no-op with a warning", () => {
    const decision = classifyForkRouteSwitch(
      { provider: SESSION_PROVIDER, model: SESSION_MODEL },
      current,
      ctxWith(true),
      "fork-42",
    );
    expect(decision.kind).toBe("noop");
    if (decision.kind === "noop") {
      expect(decision.warning).toContain("agent fork-42 already runs");
      expect(decision.warning).toContain(`${SESSION_PROVIDER}/${SESSION_MODEL}`);
      expect(decision.warning).toContain("Omit `routing`");
    }
  });

  it("stays a no-op even with the setting off — nothing is being changed", () => {
    const decision = classifyForkRouteSwitch(
      { provider: SESSION_PROVIDER, model: SESSION_MODEL },
      current,
      ctxWith(false),
    );
    expect(decision.kind).toBe("noop");
  });

  it("rejects a genuine switch while the setting is off", () => {
    const decision = classifyForkRouteSwitch(
      { provider: OTHER_PROVIDER, model: OTHER_MODEL },
      current,
      ctxWith(false),
    );
    expect(decision.kind).toBe("rejected");
    if (decision.kind === "rejected") {
      expect(decision.error).toContain("MultiModelForkDisabled");
    }
  });

  it("classifies a genuine switch as owing an approval prompt", () => {
    const decision = classifyForkRouteSwitch(
      { provider: OTHER_PROVIDER, model: OTHER_MODEL },
      current,
      ctxWith(true),
    );
    expect(decision).toEqual({
      kind: "switch",
      route: { provider: OTHER_PROVIDER, model: OTHER_MODEL },
    });
  });

  it("reports no request at all when the field is absent", () => {
    expect(classifyForkRouteSwitch(undefined, current, ctxWith(true))).toEqual({
      kind: "inherit",
    });
  });
});

describe("pinning a route", () => {
  it("drops an effort level the pinned model cannot serve", () => {
    const target = { provider: OTHER_PROVIDER, model: OTHER_MODEL } as const;
    expect(effortLevelsForModel(target)).not.toContain("max");
    const ctx = { ...ctxWith(true), effort: "max" } as RequestContext;

    const pinned = withPinnedForkRoute(ctx, target);

    expect(pinned.provider).toBe(OTHER_PROVIDER);
    expect(pinned.model).toBe(OTHER_MODEL);
    expect(pinned.effort).toBe(defaultEffortForModel(target));
    expect(pinned.sessionId).toBe(ctx.sessionId);
  });

  it("keeps an effort level the pinned model does serve", () => {
    const target = { provider: OTHER_PROVIDER, model: OTHER_MODEL } as const;
    const ctx = { ...ctxWith(true), effort: "low" } as RequestContext;
    expect(withPinnedForkRoute(ctx, target).effort).toBe("low");
  });
});
