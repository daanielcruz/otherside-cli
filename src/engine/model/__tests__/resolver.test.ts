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
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { credentialsPath } from "@/kernel/storage/credentials.ts";
import { quotaDisplacedBeforeTopNSelection } from "../tier/quota-displacement.ts";
import {
  resolveTier,
  resolveTierDetailed,
  resolveTierRank,
  resolveTierRankDetailed,
  resolveTierTopN,
  resolveTierTopNWithCascadeDetailed,
  tierContainsModel,
} from "../tier/resolver.ts";
import {
  invalidateCredentialsMemoForTests,
  isProviderUsable,
  isProviderUsableNow,
  setCredentialsLoaderForTests,
} from "../tier/usability.ts";

registerAllProviders();

// Hermetic credential bundle: every provider configured so credential gating
// never interferes with the routing-usage assertions below.
const ALL_PROVIDERS = (): CredentialsBundle =>
  ({
    anthropic: { accessToken: "x" },
    codex: { accessToken: "x" },
    glm: { zcodeJwtToken: "x" },
    antigravity: { accessToken: "x" },
    xai: { apiKey: "x" },
    kimi: { apiKey: "x" },
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
        isOverageActive: false,
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
        isOverageActive: false,
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
    const detail = resolveTierDetailed("shogun");
    const glmCandidate = detail.candidates.find((candidate) => candidate.provider === "glm");
    expect(glmCandidate?.blocked).toBe(true);
    expect(glmCandidate?.blockedReasons.some((reason) => reason.includes("utilization"))).toBe(
      true,
    );
  });

  it("keeps a high-but-not-spent active provider routeable (no predictive block)", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 99 });
    const detail = resolveTierDetailed("emperor", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(false);
  });

  it("blocks the active provider too when its balance is exhausted (no exemption)", () => {
    setRoutingUsage("codex", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    const detail = resolveTierDetailed("emperor", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(true);
    expect(codexCandidate?.quotaBlocked).toBe(true);
    expect(
      codexCandidate?.blockedReasons.some((reason) => reason.includes("balance exhausted")),
    ).toBe(true);
  });

  it("blocks the active provider too at 100% utilization (no exemption)", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 100 });
    const detail = resolveTierDetailed("emperor", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(true);
    expect(codexCandidate?.quotaBlocked).toBe(true);
  });

  it("still blocks the active provider under a runtime cooldown", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const detail = resolveTierDetailed("emperor", undefined, "codex");
    const codexCandidate = detail.candidates.find((candidate) => candidate.provider === "codex");
    expect(codexCandidate?.blocked).toBe(true);
  });

  it("keeps the active provider routeable when usage is unavailable", () => {
    const detail = resolveTierDetailed("emperor", undefined, "anthropic");
    const anthropicCandidate = detail.candidates.find(
      (candidate) => candidate.provider === "anthropic",
    );
    expect(anthropicCandidate?.blocked).toBe(false);
  });

  it("re-admits an exhausted provider immediately after a recovery observation", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", balanceStatus: "exhausted" });
    expect(
      resolveTierDetailed("emperor").candidates.find((candidate) => candidate.provider === "codex")
        ?.blocked,
    ).toBe(true);
    // Live SoT recovery — no cooldown, no waiting: the very next resolve sees it.
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "available",
    });
    expect(
      resolveTierDetailed("emperor").candidates.find((candidate) => candidate.provider === "codex")
        ?.blocked,
    ).toBe(false);
  });

  it("surfaces an Opus 5 model cooldown and falls through to the next emperor", () => {
    const until = Date.now() + 60_000;
    markProviderCooldown("anthropic", until, "rate_limited", "claude-opus-5");

    const detail = resolveTierDetailed("emperor");
    const opus = detail.candidates.find((candidate) => candidate.model === "claude-opus-5");

    expect(detail.resolution).toEqual({ provider: "codex", model: "gpt-6-astra" });
    expect(opus?.blocked).toBe(true);
    expect(opus?.cooldownUntilEpochMs).toBe(until);
    expect(
      opus?.blockedReasons.some((reason) => reason.includes("model claude-opus-5 cooldown")),
    ).toBe(true);
  });
});

describe("emperor Anthropic roster", () => {
  it("uses Opus 5 regardless of the Fable weekly window", () => {
    setUsageLimits(
      { seven_day_fable: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 86_400 } },
      {
        status: "allowed",
        unifiedRateLimitFallbackAvailable: false,
        isOverageActive: false,
      },
    );
    const detail = resolveTierDetailed("emperor");
    expect(detail.resolution).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(detail.candidates.some((candidate) => candidate.model === "claude-fable-5")).toBe(false);
    expect(detail.candidates.some((candidate) => candidate.model === "claude-opus-4-8")).toBe(
      false,
    );
  });
});

describe("resolveTierRank strict semantics", () => {
  // daimyo roster sorted by pos: 1 codex, 2 antigravity, 3 antigravity, 4 xai, 5 deepseek
  it("maps a rank to the fixed roster slot", () => {
    observeProvider("antigravity");
    observeProvider("codex");

    expect(resolveTierRank("daimyo", 1)?.provider).toBe("codex");
    expect(resolveTierRank("daimyo", 2)?.provider).toBe("antigravity");
    expect(resolveTierRank("daimyo", 4)?.provider).toBe("xai");
  });

  it("returns null for a blocked slot instead of falling back to another provider", () => {
    observeProvider("codex");
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const ranked = resolveTierRankDetailed("daimyo", 1);
    expect(ranked.resolution).toBeNull();
    expect(ranked.candidate?.provider).toBe("codex");
    // Strict rank must NOT compact to the next usable provider (antigravity).
    expect(resolveTierRank("daimyo", 1)).toBeNull();
    expect(resolveTierRank("daimyo", 2)?.provider).toBe("antigravity");
  });

  it("rejects out-of-range ranks", () => {
    expect(resolveTierRankDetailed("samurai", 9).error).toContain("rank");
    expect(resolveTierRank("samurai", 9)).toBeNull();
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
        isOverageActive: false,
      },
    );
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const top = resolveTierTopN("daimyo", 3);
    const providers = top.map((r) => r.provider);
    expect(providers).not.toContain("codex");
    // Top-N selects distinct providers, so antigravity's two roster slots
    // compact to one entry: antigravity, xai, deepseek.
    expect(providers.length).toBe(3);
    expect(new Set(providers).size).toBe(3);
    expect(providers[0]).toBe("antigravity");
  });

  it("resolveTier returns the first usable provider", () => {
    observeProvider("codex");
    const resolved = resolveTier("daimyo");
    expect(resolved?.provider).toBe("codex");
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
    expect(tierContainsModel("emperor", "anthropic", "claude-opus-5")).toBe(true);
    expect(tierContainsModel("emperor", "codex", "gpt-6-astra")).toBe(true);
    expect(tierContainsModel("samurai", "anthropic", "claude-haiku-4-5")).toBe(true);
  });

  it("ignores the context-window suffix when matching", () => {
    expect(tierContainsModel("emperor", "anthropic", "claude-opus-5")).toBe(true);
    expect(tierContainsModel("emperor", "anthropic", "claude-opus-5[1m]")).toBe(true);
  });

  it("is false across tiers and for unknown models/providers", () => {
    expect(tierContainsModel("emperor", "anthropic", "claude-haiku-4-5")).toBe(false);
    expect(tierContainsModel("samurai", "codex", "gpt-6-astra")).toBe(false);
    expect(tierContainsModel("emperor", "anthropic", "made-up-model")).toBe(false);
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

    const result = resolveTierDetailed("samurai", undefined, "anthropic");

    // Should pick anthropic (claude-haiku-4-5) over the unobserved higher ranks
    // because anthropic is observed and they are not.
    expect(result.selected?.provider).toBe("anthropic");
    expect(result.selected?.model).toBe("claude-haiku-4-5");
  });

  it("does not hard-block unobserved providers when all are unobserved", () => {
    // Leave every provider as null (unobserved).
    const result = resolveTierDetailed("samurai", undefined, "anthropic");

    // Should fall through normally by pos order (picking gemini-3.8-flash-low
    // on antigravity, samurai rank 1).
    expect(result.selected?.provider).toBe("antigravity");
    expect(result.selected?.model).toBe("gemini-3.8-flash-low");
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

  it("does not reuse credentials from a different path with the same mtime", () => {
    const firstPath = writeCreds({
      anthropic: {
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 60_000,
      },
    });
    const normalizedMs = Math.trunc(statSync(firstPath).mtimeMs);
    const pinned = new Date(normalizedMs);
    utimesSync(firstPath, pinned, pinned);
    expect(isProviderUsableNow("anthropic")).toBe(true);

    const secondConfigDir = `${configDir}-second`;
    try {
      process.env.OTHERSIDE_CONFIG_DIR = secondConfigDir;
      mkdirSync(secondConfigDir, { recursive: true });
      const secondPath = credentialsPath();
      writeFileSync(secondPath, "{}\n", "utf8");
      utimesSync(secondPath, pinned, pinned);
      expect(statSync(secondPath).mtimeMs).toBe(normalizedMs);
      expect(isProviderUsableNow("anthropic")).toBe(false);
    } finally {
      process.env.OTHERSIDE_CONFIG_DIR = configDir;
      rmSync(secondConfigDir, { recursive: true, force: true });
    }
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
  it("cascades emperor to shogun when all emperor candidates are blocked", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");

    observeProvider("antigravity");
    observeProvider("codex");

    // emperor (fable/sol/opus) is fully blocked; shogun still has grok-4.6 + glm.
    const result = resolveTierTopNWithCascadeDetailed("emperor", 3);
    expect(result.selectedTier).toBe("shogun");
    expect(result.selected.length).toBeGreaterThan(0);
    for (const c of result.selected) {
      expect(c.tier).toBe("shogun");
    }
  });

  it("stops at first tier with at least 1 usable candidate, even if less than count, and does not mix", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("deepseek", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("kimi", Date.now() + 60_000, "rate_limited");

    // Only xai survives; the cascade stops at shogun (grok-4.6) with a single
    // usable candidate and never mixes daimyo entries in.
    const result = resolveTierTopNWithCascadeDetailed("emperor", 3);
    expect(result.selectedTier).toBe("shogun");
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]!.provider).toBe("xai");
  });

  it("returns empty when no candidate is usable in any tier", () => {
    for (const p of [
      "codex",
      "anthropic",
      "glm",
      "antigravity",
      "xai",
      "deepseek",
      "kimi",
      "minimax",
    ]) {
      markProviderCooldown(p as ProviderId, Date.now() + 60_000, "rate_limited");
    }

    const result = resolveTierTopNWithCascadeDetailed("emperor", 3);
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

    // emperor is fully blocked (codex quota-spent, anthropic cooled); the
    // cascade lands on shogun via xai while codex remains the displaced slot.
    const result = resolveTierTopNWithCascadeDetailed("emperor", 3);
    expect(result.selectedTier).toBe("shogun");

    const displaced = quotaDisplacedBeforeTopNSelection(result);
    expect(displaced).not.toBeNull();
    expect(displaced?.provider).toBe("codex");
    expect(displaced?.tier).toBe("emperor");
  });

  it("detects quota displaced candidate skipped in the selected tier", () => {
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");

    setRoutingUsage("xai", { trackingStatus: "tracked", utilizationPct: 100 });
    observeProvider("codex");

    const result = resolveTierTopNWithCascadeDetailed("shogun", 1);
    expect(result.selectedTier).toBe("shogun");
    expect(result.selected.map((s) => s.provider)).toContain("codex");
    expect(result.selected.map((s) => s.provider)).not.toContain("xai");

    const displaced = quotaDisplacedBeforeTopNSelection(result);
    expect(displaced).not.toBeNull();
    expect(displaced?.provider).toBe("xai");
    expect(displaced?.tier).toBe("shogun");
  });
});
