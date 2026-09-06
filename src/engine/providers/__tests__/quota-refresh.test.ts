import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invalidateProviderQuota,
  providerUsagePayload,
  QUOTA_FAILURE_RETRY_COOLDOWN_MS,
  QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS,
  quotaRefreshMeta,
  refreshProviderQuota,
  resetQuotaRefreshMetaForTests,
  setQuotaRefresherForTests,
  setQuotaRefreshNowForTests,
} from "@/engine/providers/quota-refresh.ts";
import {
  clearRoutingUsage,
  getRoutingUsage,
  setRoutingUsage,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import { QUOTA_REFRESH_COOLDOWN_MS } from "@/engine/session/usage/quota-warning.ts";
import { normalizeRoutingUsageInput } from "@/engine/session/usage/routing-usage-normalize.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

let configDir = "";
let previousConfigDir: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = await mkdtemp(join(tmpdir(), "otherside-quota-refresh-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  resetQuotaRefreshMetaForTests();
  setQuotaRefreshNowForTests(null);
  setQuotaRefresherForTests("glm", null);
  setQuotaRefresherForTests("codex", null);
  setQuotaRefresherForTests("antigravity", null);
  clearRoutingUsage();
  stopUsageSweepTimerForTests();
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  await rm(configDir, { recursive: true, force: true });
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
    expect(a).toEqual({ ok: true, source: "network", data: { ok: true } });
    expect(b).toEqual({ ok: true, source: "network", data: { ok: true } });
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

    const payload = { primary: null, secondary: null };
    const first = await refreshProviderQuota("codex");
    expect(first).toEqual({ ok: true, source: "network", data: payload });
    expect(fetchCount).toBe(1);

    // The cooldown skip serves the cached payload so display surfaces can
    // still render without a network hit.
    const second = await refreshProviderQuota("codex");
    expect(second).toEqual({ ok: true, source: "cache", data: payload });
    expect(fetchCount).toBe(1);

    const forced = await refreshProviderQuota("codex", { force: true });
    expect(forced).toEqual({ ok: true, source: "network", data: payload });
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
    expect(skipped).toEqual({ ok: false, error: "blip" });
    expect(fetchCount).toBe(1);

    now += QUOTA_FAILURE_RETRY_COOLDOWN_MS + 1;
    const retried = await refreshProviderQuota("glm");
    expect(retried).toEqual({ ok: false, error: "blip" });
    expect(fetchCount).toBe(2);
  });

  it("returns unsupported for providers without a refresher", async () => {
    const outcome = await refreshProviderQuota("openai");
    expect(outcome).toEqual({ ok: true, source: "unsupported", data: null });
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
    expect(await refreshProviderQuota("glm")).toEqual({
      ok: true,
      source: "cache",
      data: null,
    });
    now += 1;
    expect(await refreshProviderQuota("glm")).toEqual({ ok: true, source: "network", data: null });
    expect(fetchCount).toBe(2);
  });

  it("invalidates cache and quota state when credential identity changes", async () => {
    let fetchCount = 0;
    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        fetchCount += 1;
        return { fetchCount };
      },
      apply: (data) => {
        setRoutingUsage("glm", {
          trackingStatus: "tracked",
          utilizationPct: (data as { fetchCount: number }).fetchCount * 10,
        });
      },
    });

    await refreshProviderQuota("glm");
    expect(getRoutingUsage("glm")?.utilizationPct).toBe(10);

    invalidateProviderQuota("glm");
    expect(getRoutingUsage("glm")).toBeNull();
    expect(quotaRefreshMeta("glm").lastSuccessAtEpochMs).toBeNull();

    expect(await refreshProviderQuota("glm")).toEqual({
      ok: true,
      source: "network",
      data: { fetchCount: 2 },
    });
    expect(fetchCount).toBe(2);
  });

  it("discards an in-flight response from a prior credential generation", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let applyCount = 0;
    setQuotaRefresherForTests("glm", {
      fetch: () => gate,
      apply: () => {
        applyCount += 1;
      },
    });

    const pending = refreshProviderQuota("glm");
    invalidateProviderQuota("glm");
    release({ stale: true });

    expect(await pending).toEqual({
      ok: false,
      error: "credentials changed during usage refresh",
    });
    expect(applyCount).toBe(0);
    expect(quotaRefreshMeta("glm").lastSuccessAtEpochMs).toBeNull();
  });

  // Fetching usage can renew a near-expiry token and save it. That save is the same
  // account speaking with a new voice — the fetch's own result must survive it, or a
  // provider that renews on every fetch never shows usage at all.
  it("keeps a fetch whose own token renewal saved mid-flight", async () => {
    await saveFor("antigravity", {
      accessToken: "t1",
      refreshToken: "r1",
      expiresAt: 1,
      email: "account@placeholder.dev",
    });
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let applied = 0;
    setQuotaRefresherForTests("antigravity", {
      fetch: () => gate,
      apply: () => {
        applied += 1;
      },
    });

    const pending = refreshProviderQuota("antigravity");
    await saveFor("antigravity", {
      accessToken: "t2",
      refreshToken: "r1",
      expiresAt: 2,
      email: "account@placeholder.dev",
    });
    release({ fresh: true });

    expect(await pending).toEqual({ ok: true, source: "network", data: { fresh: true } });
    expect(applied).toBe(1);
  });

  it("still discards a fetch when the account itself changed mid-flight", async () => {
    await saveFor("antigravity", {
      accessToken: "t1",
      refreshToken: "r1",
      expiresAt: 1,
      email: "first@placeholder.dev",
    });
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let applied = 0;
    setQuotaRefresherForTests("antigravity", {
      fetch: () => gate,
      apply: () => {
        applied += 1;
      },
    });

    const pending = refreshProviderQuota("antigravity");
    await saveFor("antigravity", {
      accessToken: "t9",
      refreshToken: "r9",
      expiresAt: 9,
      email: "second@placeholder.dev",
    });
    release({ stale: true });

    expect(await pending).toEqual({
      ok: false,
      error: "credentials changed during usage refresh",
    });
    expect(applied).toBe(0);
  });

  it("maxAgeMs narrows the manual-refresh window inside the success cooldown", async () => {
    let now = 9_000_000;
    setQuotaRefreshNowForTests(() => now);
    let fetchCount = 0;
    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        fetchCount += 1;
        return { fetchCount };
      },
      apply: () => {},
    });

    await refreshProviderQuota("glm");
    now += QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS - 1;
    // Inside the manual window: even a user-initiated refresh serves cache.
    expect(
      await refreshProviderQuota("glm", { maxAgeMs: QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS }),
    ).toEqual({ ok: true, source: "cache", data: { fetchCount: 1 } });
    now += 1;
    // Past the manual window but inside the default cooldown: manual refetches...
    expect(
      await refreshProviderQuota("glm", { maxAgeMs: QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS }),
    ).toEqual({ ok: true, source: "network", data: { fetchCount: 2 } });
    // ...while the default-window path still serves cache.
    expect(await refreshProviderQuota("glm")).toEqual({
      ok: true,
      source: "cache",
      data: { fetchCount: 2 },
    });
    expect(fetchCount).toBe(2);
  });
});

describe("cross-process shared cache", () => {
  it("adopts a sibling session's fresh shared observation instead of refetching", async () => {
    let now = 2_000_000;
    setQuotaRefreshNowForTests(() => now);
    let fetchCount = 0;
    const refresher = {
      fetch: async () => {
        fetchCount += 1;
        return { windows: [] };
      },
      apply: () => {},
    };
    setQuotaRefresherForTests("glm", refresher);

    // First session fetches over the network and shares the observation.
    expect(await refreshProviderQuota("glm")).toEqual({
      ok: true,
      source: "network",
      data: { windows: [] },
    });
    expect(fetchCount).toBe(1);

    // A second session starting fresh (cold in-memory state) inside the shared
    // cooldown window adopts the shared record instead of polling again.
    resetQuotaRefreshMetaForTests();
    setQuotaRefreshNowForTests(() => now);
    setQuotaRefresherForTests("glm", refresher);
    now += QUOTA_REFRESH_COOLDOWN_MS - 1;
    expect(await refreshProviderQuota("glm")).toEqual({
      ok: true,
      source: "cache",
      data: { windows: [] },
    });
    expect(fetchCount).toBe(1);
  });

  it("stamps a shared error so peer sessions back off the failure window", async () => {
    let now = 3_000_000;
    setQuotaRefreshNowForTests(() => now);
    let fetchCount = 0;
    const refresher = {
      fetch: async () => {
        fetchCount += 1;
        throw new Error("429");
      },
      apply: () => {},
    };
    setQuotaRefresherForTests("glm", refresher);

    await refreshProviderQuota("glm");
    expect(fetchCount).toBe(1);

    // A peer with no payload of its own must not re-hit the API inside the
    // shared failure window.
    resetQuotaRefreshMetaForTests();
    setQuotaRefreshNowForTests(() => now);
    setQuotaRefresherForTests("glm", refresher);
    now += QUOTA_FAILURE_RETRY_COOLDOWN_MS - 1;
    await expect(providerUsagePayload("glm")).rejects.toThrow("429");
    expect(fetchCount).toBe(1);
  });
});

describe("providerUsagePayload", () => {
  it("returns the fetched payload and the cached payload on cooldown skips", async () => {
    let fetchCount = 0;
    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        fetchCount += 1;
        return { windows: [] };
      },
      apply: () => {},
    });

    expect(await providerUsagePayload<{ windows: unknown[] }>("glm")).toEqual({ windows: [] });
    expect(await providerUsagePayload<{ windows: unknown[] }>("glm")).toEqual({ windows: [] });
    expect(fetchCount).toBe(1);
  });

  it("throws the fetch error, and rethrows the last error on a cacheless cooldown skip", async () => {
    setQuotaRefresherForTests("glm", {
      fetch: async () => {
        throw new Error("upstream timeout");
      },
      apply: () => {},
    });

    await expect(providerUsagePayload("glm")).rejects.toThrow("upstream timeout");
    // Failure cooldown with no cached payload: surfaces the stored error
    // instead of pretending the provider reported nothing.
    await expect(providerUsagePayload("glm")).rejects.toThrow("upstream timeout");
  });

  it("returns null for providers without a refresher", async () => {
    expect(await providerUsagePayload("openai")).toBeNull();
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
