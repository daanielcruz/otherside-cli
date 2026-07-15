import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setRoutingUsage,
  setUsageLimits,
} from "@/engine/session/usage/limits.ts";
import {
  clearProviderCooldowns,
  markProviderCooldown,
} from "@/engine/session/usage/provider-health.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { credentialsPath } from "@/kernel/storage/credentials.ts";
import {
  invalidateCredentialsMemoForTests,
  isProviderUsable,
  isProviderUsableNow,
  quotaDisplacedBeforeTopNSelection,
  resolveTier,
  resolveTierDetailed,
  resolveTierRank,
  resolveTierRankDetailed,
  resolveTierTopN,
  resolveTierTopNWithCascadeDetailed,
  setCredentialsLoaderForTests,
  tierContainsModel,
} from "../tier/resolver.ts";

registerAllProviders();

// Hermetic credential bundle: every provider configured so credential gating
// never interferes with the routing-usage assertions below.
const ALL_PROVIDERS = (): CredentialsBundle =>
  ({
    anthropic: { accessToken: "x" },
    codex: { accessToken: "x" },
    glm: { zcodeJwtToken: "x" },
    antigravity: { accessToken: "x" },
    "kimi-code": { apiKey: "x" },
    deepseek: { apiKey: "x" },
    minimax: { apiKey: "x" },
  }) as unknown as CredentialsBundle;

beforeEach(() => {
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  setCredentialsLoaderForTests(ALL_PROVIDERS);
});

afterEach(() => {
  setCredentialsLoaderForTests(null);
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
});

function observeProvider(provider: Parameters<typeof setRoutingUsage>[0]): void {
  setRoutingUsage(provider, { trackingStatus: "untracked", balanceStatus: "unknown" });
}

describe("isProviderUsable — raw usability (no active-provider exemption)", () => {
  const creds = ALL_PROVIDERS();

  it("blocks a tracked provider at 100% utilization (real exhaustion)", () => {
    setRoutingUsage("glm", { trackingStatus: "tracked", utilizationPct: 100 });
    expect(isProviderUsable("glm", creds)).toBe(false);
  });

  it("never blocks predictively below 100% (raw, untruncated percentage)", () => {
    setRoutingUsage("glm", { trackingStatus: "tracked", utilizationPct: 99.9 });
    expect(isProviderUsable("glm", creds)).toBe(true);
  });

  it("blocks an exhausted balance", () => {
    setRoutingUsage("deepseek", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    expect(isProviderUsable("deepseek", creds)).toBe(false);
  });

  it("allows unknown/untracked providers by default (user responsibility)", () => {
    expect(isProviderUsable("minimax", creds)).toBe(true);
    setRoutingUsage("minimax", { trackingStatus: "untracked", balanceStatus: "unknown" });
    expect(isProviderUsable("minimax", creds)).toBe(true);
  });

  it("blocks anthropic when its plan-limit snapshot is rejected, even below 100%", () => {
    expect(isProviderUsable("anthropic", creds)).toBe(true);
    setUsageLimits(
      {},
      {
        status: "rejected",
        unifiedRateLimitFallbackAvailable: false,
        utilization: 0.8,
        isUsingOverage: false,
      },
    );
    expect(isProviderUsable("anthropic", creds)).toBe(false);
  });

  it("keeps anthropic usable at 100% while its plan-limit snapshot still allows requests", () => {
    // The snapshot's own "allowed" verdict is an explicit availability signal;
    // it wins over the derived (possibly rounded) 100% utilization.
    setUsageLimits(
      {},
      {
        status: "allowed",
        unifiedRateLimitFallbackAvailable: false,
        utilization: 1,
        isUsingOverage: false,
      },
    );
    expect(isProviderUsable("anthropic", creds)).toBe(true);
  });

  it("blocks a provider under runtime cooldown", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    expect(isProviderUsable("codex", creds)).toBe(false);
  });

  it("blocks providers without configured credentials", () => {
    expect(isProviderUsable("glm", null)).toBe(false);
  });
});

describe("resolveTierDetailed routing diagnostics", () => {
  it("marks a fully spent tracked provider blocked with a utilization reason", () => {
    setRoutingUsage("glm", { trackingStatus: "tracked", utilizationPct: 100 });
    const detail = resolveTierDetailed("general");
    const glmCandidate = detail.candidates.find((candidate) => candidate.provider === "glm");
    expect(glmCandidate?.blocked).toBe(true);
    expect(glmCandidate?.blockedReasons.some((reason) => reason.includes("utilization"))).toBe(
      true,
    );
  });

  it("keeps a high-but-not-spent active provider routeable (no predictive block)", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 99 });
    const detail = resolveTierDetailed("general", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(false);
  });

  it("blocks the active provider too when its balance is exhausted (no exemption)", () => {
    setRoutingUsage("codex", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    const detail = resolveTierDetailed("general", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(true);
    expect(codexCandidate?.quotaBlocked).toBe(true);
    expect(
      codexCandidate?.blockedReasons.some((reason) => reason.includes("balance exhausted")),
    ).toBe(true);
  });

  it("blocks the active provider too at 100% utilization (no exemption)", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 100 });
    const detail = resolveTierDetailed("general", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(true);
    expect(codexCandidate?.quotaBlocked).toBe(true);
  });

  it("still blocks the active provider under a runtime cooldown", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const detail = resolveTierDetailed("general", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(true);
  });

  it("keeps the active provider routeable when usage is unavailable", () => {
    const detail = resolveTierDetailed("general", undefined, "anthropic");
    const anthropicCandidate = detail.candidates.find(
      (candidate) => candidate.provider === "anthropic",
    );
    expect(anthropicCandidate?.blocked).toBe(false);
  });

  it("re-admits an exhausted provider immediately after a recovery observation", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", balanceStatus: "exhausted" });
    expect(
      resolveTierDetailed("general").candidates.find((candidate) => candidate.provider === "codex")
        ?.blocked,
    ).toBe(true);
    // Live SoT recovery — no cooldown, no waiting: the very next resolve sees it.
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "available",
    });
    expect(
      resolveTierDetailed("general").candidates.find((candidate) => candidate.provider === "codex")
        ?.blocked,
    ).toBe(false);
  });

  it("surfaces a model-scoped cooldown while routing to a sibling model", () => {
    // anthropic-only credentials: the sibling-model routing under test lives on
    // anthropic (fable -> opus); other providers would outrank it in the roster.
    setCredentialsLoaderForTests(
      () => ({ anthropic: { accessToken: "x" } }) as unknown as CredentialsBundle,
    );
    const until = Date.now() + 60_000;
    markProviderCooldown("anthropic", until, "rate_limited", "claude-fable-5");

    const detail = resolveTierDetailed("general");
    const fable = detail.candidates.find((candidate) => candidate.model === "claude-fable-5");
    const opus = detail.candidates.find((candidate) => candidate.model === "claude-opus-4-8");

    expect(detail.resolution).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(fable?.blocked).toBe(true);
    expect(fable?.cooldownUntilEpochMs).toBe(until);
    expect(
      fable?.blockedReasons.some((reason) => reason.includes("model claude-fable-5 cooldown")),
    ).toBe(true);
    expect(opus?.blocked).toBe(false);
  });
});

describe("Fable weekly limit gates only the Fable model", () => {
  const futureSeconds = (): number => Math.floor(Date.now() / 1000) + 86_400;
  const allowed = {
    status: "allowed",
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  } as const;

  it("falls through to opus when the Fable week is spent", () => {
    setUsageLimits({ seven_day_fable: { utilization: 1, resetsAt: futureSeconds() } }, allowed);
    const resolved = resolveTier("general");
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.model).toBe("claude-opus-4-8");
  });

  it("keeps Fable selected when its week still has room", () => {
    setUsageLimits({ seven_day_fable: { utilization: 0.5, resetsAt: futureSeconds() } }, allowed);
    expect(resolveTier("general")?.model).toBe("claude-fable-5");
  });

  it("keeps Fable once its week has reset", () => {
    setUsageLimits(
      { seven_day_fable: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) - 10 } },
      allowed,
    );
    expect(resolveTier("general")?.model).toBe("claude-fable-5");
  });
});

describe("resolveTierRank strict semantics", () => {
  // warrior roster sorted by pos: 1 antigravity, 2 codex, 3 anthropic, ...
  it("maps a rank to the fixed roster slot", () => {
    observeProvider("antigravity");
    observeProvider("codex");

    expect(resolveTierRank("warrior", 1)?.provider).toBe("antigravity");
    expect(resolveTierRank("warrior", 2)?.provider).toBe("codex");
    expect(resolveTierRank("warrior", 3)?.provider).toBe("anthropic");
  });

  it("returns null for a blocked slot instead of falling back to another provider", () => {
    observeProvider("codex");
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const ranked = resolveTierRankDetailed("warrior", 2);
    expect(ranked.resolution).toBeNull();
    expect(ranked.candidate?.provider).toBe("codex");
    // Strict rank must NOT compact to the next usable provider (anthropic).
    expect(resolveTierRank("warrior", 2)).toBeNull();
    expect(resolveTierRank("warrior", 3)?.provider).toBe("anthropic");
  });

  it("rejects out-of-range ranks", () => {
    expect(resolveTierRankDetailed("scout", 9).error).toContain("rank");
    expect(resolveTierRank("scout", 9)).toBeNull();
  });
});

describe("top-N compaction vs strict rank", () => {
  it("top-N skips a blocked provider and compacts the remaining usable ones", () => {
    observeProvider("antigravity");
    setUsageLimits(
      {},
      {
        status: "allowed",
        unifiedRateLimitFallbackAvailable: false,
        utilization: 0.1,
        isUsingOverage: false,
      },
    );
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const top = resolveTierTopN("warrior", 3);
    const providers = top.map((r) => r.provider);
    expect(providers).not.toContain("codex");
    expect(providers.length).toBe(3);
    expect(new Set(providers).size).toBe(3);
  });

  it("resolveTier returns the first usable provider", () => {
    observeProvider("antigravity");
    const resolved = resolveTier("warrior");
    expect(resolved?.provider).toBe("antigravity");
  });
});

describe("invalid / legacy tier names", () => {
  it("returns null instead of throwing a TypeError", () => {
    // Legacy names like "best"/"explorer" must degrade gracefully.
    expect(resolveTier("best" as never)).toBeNull();
    expect(resolveTierRank("explorer" as never, 1)).toBeNull();
    expect(resolveTierDetailed("dumbfast" as never).resolution).toBeNull();
  });
});

describe("tierContainsModel", () => {
  it("matches a model that defines the tier", () => {
    expect(tierContainsModel("general", "anthropic", "claude-opus-4-8")).toBe(true);
    expect(tierContainsModel("general", "codex", "gpt-5.6-sol")).toBe(true);
    expect(tierContainsModel("scout", "anthropic", "claude-haiku-4-5")).toBe(true);
  });

  it("ignores the context-window suffix when matching", () => {
    expect(tierContainsModel("general", "anthropic", "claude-opus-4-8")).toBe(true);
    expect(tierContainsModel("general", "anthropic", "claude-opus-4-8[1m]")).toBe(true);
  });

  it("is false across tiers and for unknown models/providers", () => {
    expect(tierContainsModel("general", "anthropic", "claude-haiku-4-5")).toBe(false);
    expect(tierContainsModel("scout", "codex", "gpt-5.6-sol")).toBe(false);
    expect(tierContainsModel("general", "anthropic", "made-up-model")).toBe(false);
    expect(tierContainsModel("best" as never, "anthropic", "claude-opus-4-8")).toBe(false);
  });
});

describe("unobserved provider routing deprioritization", () => {
  it("deprioritizes unobserved providers when a usable observed provider exists", () => {
    // Set routing usage for anthropic (scout rank 4) as tracked + usable.
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 50,
      balanceStatus: "available",
    });
    // Leave the higher scout ranks (antigravity, xai, codex) unobserved.

    const result = resolveTierDetailed("scout", undefined, "anthropic");

    // Should pick anthropic (claude-haiku-4-5) over the unobserved higher ranks
    // because anthropic is observed and they are not.
    expect(result.selected?.provider).toBe("anthropic");
    expect(result.selected?.model).toBe("claude-haiku-4-5");
  });

  it("does not hard-block unobserved providers when all are unobserved", () => {
    // Leave every provider as null (unobserved).
    const result = resolveTierDetailed("scout", undefined, "anthropic");

    // Should fall through normally by pos order (picking gemini-3-flash-medium
    // on antigravity, scout rank 1).
    expect(result.selected?.provider).toBe("antigravity");
    expect(result.selected?.model).toBe("gemini-3-flash-medium");
  });
});

describe("loadCredentialsSync mtime memo", () => {
  const configDir = join(
    tmpdir(),
    `otherside-resolver-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    // Hit the real disk path — bypass the hermetic loader override used above.
    setCredentialsLoaderForTests(null);
    invalidateCredentialsMemoForTests();
    clearRoutingUsage();
    clearUsageLimits();
    clearProviderCooldowns();
    rmSync(configDir, { recursive: true, force: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    setCredentialsLoaderForTests(null);
    invalidateCredentialsMemoForTests();
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  const writeCreds = (bundle: Record<string, unknown>): string => {
    const path = credentialsPath();
    writeFileSync(path, `${JSON.stringify(bundle)}\n`, "utf8");
    return path;
  };

  it("re-reads credentials when mtime changes", () => {
    writeCreds({
      anthropic: {
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(isProviderUsableNow("anthropic")).toBe(true);

    const path = writeCreds({});
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    expect(isProviderUsableNow("anthropic")).toBe(false);
  });

  it("invalidateCredentialsMemoForTests forces a re-read even when mtime is unchanged", () => {
    const path = writeCreds({
      anthropic: {
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 60_000,
      },
    });
    // Normalize mtime to integer ms so a later utimesSync pin matches exactly.
    const normalizedMs = Math.trunc(statSync(path).mtimeMs);
    const pinned = new Date(normalizedMs);
    utimesSync(path, pinned, pinned);
    expect(statSync(path).mtimeMs).toBe(normalizedMs);

    expect(isProviderUsableNow("anthropic")).toBe(true);

    writeFileSync(path, "{}\n", "utf8");
    // Pin mtime back so a memoized load would keep serving the old bundle.
    utimesSync(path, pinned, pinned);
    expect(statSync(path).mtimeMs).toBe(normalizedMs);
    expect(isProviderUsableNow("anthropic")).toBe(true);

    invalidateCredentialsMemoForTests();
    expect(isProviderUsableNow("anthropic")).toBe(false);
  });
});

describe("resolveTierTopNWithCascadeDetailed and quotaDisplacedBeforeTopNSelection", () => {
  it("cascades general to warrior when all general candidates are blocked", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");

    observeProvider("antigravity");
    observeProvider("codex");

    const result = resolveTierTopNWithCascadeDetailed("general", 3);
    expect(result.selectedTier).toBe("warrior");
    expect(result.selected.length).toBeGreaterThan(0);
    for (const c of result.selected) {
      expect(c.tier).toBe("warrior");
    }
  });

  it("stops at first tier with at least 1 usable candidate, even if less than count, and does not mix", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");

    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("deepseek", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("kimi-code", Date.now() + 60_000, "rate_limited");

    const result = resolveTierTopNWithCascadeDetailed("general", 3);
    expect(result.selectedTier).toBe("warrior");
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]!.provider).toBe("minimax");
  });

  it("returns empty when no candidate is usable in any tier", () => {
    for (const p of [
      "codex",
      "anthropic",
      "glm",
      "antigravity",
      "deepseek",
      "kimi-code",
      "minimax",
    ]) {
      markProviderCooldown(p as ProviderId, Date.now() + 60_000, "rate_limited");
    }

    const result = resolveTierTopNWithCascadeDetailed("general", 3);
    expect(result.selectedTier).toBeNull();
    expect(result.selected.length).toBe(0);
    expect(result.resolutions.length).toBe(0);
    expect(result.error).not.toBeNull();
  });

  it("detects quota displaced candidate in a tier before the selected tier", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 100 });
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");

    const result = resolveTierTopNWithCascadeDetailed("general", 3);
    expect(result.selectedTier).toBe("warrior");

    const displaced = quotaDisplacedBeforeTopNSelection(result);
    expect(displaced).not.toBeNull();
    expect(displaced?.provider).toBe("codex");
    expect(displaced?.tier).toBe("general");
  });

  it("detects quota displaced candidate skipped in the selected tier", () => {
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");

    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 100 });
    observeProvider("antigravity");

    const result = resolveTierTopNWithCascadeDetailed("general", 1);
    expect(result.selectedTier).toBe("general");
    expect(result.selected.map((s) => s.provider)).toContain("antigravity");
    expect(result.selected.map((s) => s.provider)).not.toContain("codex");

    const displaced = quotaDisplacedBeforeTopNSelection(result);
    expect(displaced).not.toBeNull();
    expect(displaced?.provider).toBe("codex");
    expect(displaced?.tier).toBe("general");
  });
});
