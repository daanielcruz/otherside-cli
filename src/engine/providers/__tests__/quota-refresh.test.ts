import { afterEach, describe, expect, it } from "bun:test";
import {
  QUOTA_FAILURE_RETRY_COOLDOWN_MS,
  quotaRefreshMeta,
  refreshProviderQuota,
  resetQuotaRefreshMetaForTests,
  setQuotaRefresherForTests,
  setQuotaRefreshNowForTests,
} from "@/engine/providers/quota-refresh.ts";
import {
  clearRoutingUsage,
  getRoutingUsage,
  normalizeRoutingUsageInput,
  setRoutingUsage,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import { QUOTA_REFRESH_COOLDOWN_MS } from "@/engine/session/usage/quota-warning.ts";

afterEach(() => {
  resetQuotaRefreshMetaForTests();
  setQuotaRefreshNowForTests(null);
  setQuotaRefresherForTests("glm", null);
  setQuotaRefresherForTests("codex", null);
  clearRoutingUsage();
  stopUsageSweepTimerForTests();
});

describe("refreshProviderQuota", () => {
  it("single-flights concurrent refreshes for the same provider", async () => {
    let fetchCount = 0;
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });

    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        fetchCount += 1;
        return gate;
      },
      apply: () => {},
    });

    const first = refreshProviderQuota("glm");
    const second = refreshProviderQuota("glm");
    expect(quotaRefreshMeta("glm").inFlight).toBe(true);

    release({ ok: true });
    const [a, b] = await Promise.all([first, second]);
    expect(fetchCount).toBe(1);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(quotaRefreshMeta("glm").inFlight).toBe(false);
  });

  it("preserves last-known-good routing state when fetch throws", async () => {
    const future = Date.now() + 60 * 60_000;
    setRoutingUsage("glm", {
      trackingStatus: "tracked",
      utilizationPct: 97,
      resetsAtEpochMs: future,
    });
    expect(getRoutingUsage("glm")?.utilizationPct).toBe(97);

    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        throw new Error("upstream timeout");
      },
      apply: () => {
        throw new Error("apply must not run on fetch failure");
      },
    });

    const outcome = await refreshProviderQuota("glm");
    expect(outcome).toEqual({ ok: false, error: "upstream timeout" });
    expect(getRoutingUsage("glm")?.utilizationPct).toBe(97);
    expect(quotaRefreshMeta("glm").lastError).toBe("upstream timeout");
    expect(quotaRefreshMeta("glm").lastErrorAtEpochMs).not.toBeNull();
  });

  it("skips on success cooldown and allows force bypass", async () => {
    let fetchCount = 0;
    setQuotaRefresherForTests("codex", {
      fetch: async () => {
        fetchCount += 1;
        return { primary: null, secondary: null };
      },
      apply: () => {},
    });

    const first = await refreshProviderQuota("codex");
    expect(first).toEqual({ ok: true });
    expect(fetchCount).toBe(1);

    const second = await refreshProviderQuota("codex");
    expect(second).toEqual({ ok: true, skipped: "cooldown" });
    expect(fetchCount).toBe(1);

    const forced = await refreshProviderQuota("codex", { force: true });
    expect(forced).toEqual({ ok: true });
    expect(fetchCount).toBe(2);
  });

  it("skips on failure retry cooldown until the window elapses", async () => {
    let now = 1_000_000;
    setQuotaRefreshNowForTests(() => now);

    let fetchCount = 0;
    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        fetchCount += 1;
        throw new Error("blip");
      },
      apply: () => {},
    });

    const failed = await refreshProviderQuota("glm");
    expect(failed).toEqual({ ok: false, error: "blip" });
    expect(fetchCount).toBe(1);

    const skipped = await refreshProviderQuota("glm");
    expect(skipped).toEqual({ ok: true, skipped: "cooldown" });
    expect(fetchCount).toBe(1);

    now += QUOTA_FAILURE_RETRY_COOLDOWN_MS + 1;
    const retried = await refreshProviderQuota("glm");
    expect(retried).toEqual({ ok: false, error: "blip" });
    expect(fetchCount).toBe(2);
  });

  it("returns unsupported for providers without a refresher", async () => {
    const outcome = await refreshProviderQuota("deepseek");
    expect(outcome).toEqual({ ok: true, skipped: "unsupported" });
  });

  it("success cooldown window matches QUOTA_REFRESH_COOLDOWN_MS", async () => {
    let now = 5_000_000;
    setQuotaRefreshNowForTests(() => now);
    let fetchCount = 0;
    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        fetchCount += 1;
        return null;
      },
      apply: () => {},
    });

    await refreshProviderQuota("glm");
    now += QUOTA_REFRESH_COOLDOWN_MS - 1;
    expect(await refreshProviderQuota("glm")).toEqual({ ok: true, skipped: "cooldown" });
    now += 1;
    expect(await refreshProviderQuota("glm")).toEqual({ ok: true });
    expect(fetchCount).toBe(2);
  });
});

describe("normalizeRoutingUsageInput reset-epoch inheritance", () => {
  it("does not inherit a past previous reset epoch", () => {
    const past = Date.now() - 60_000;
    const normalized = normalizeRoutingUsageInput(
      { trackingStatus: "tracked", utilizationPct: 50 },
      {
        trackingStatus: "tracked",
        observedAtEpochMs: Date.now() - 10_000,
        balanceStatus: "available",
        utilizationPct: 90,
        resetsAtEpochMs: past,
      },
    );
    expect(normalized?.resetsAtEpochMs).toBeUndefined();
    expect(normalized?.utilizationPct).toBe(50);
  });

  it("inherits a future previous reset epoch when input omits one", () => {
    const future = Date.now() + 60_000;
    const normalized = normalizeRoutingUsageInput(
      { trackingStatus: "tracked", utilizationPct: 50 },
      {
        trackingStatus: "tracked",
        observedAtEpochMs: Date.now() - 10_000,
        balanceStatus: "available",
        utilizationPct: 90,
        resetsAtEpochMs: future,
      },
    );
    expect(normalized?.resetsAtEpochMs).toBe(future);
  });
});
