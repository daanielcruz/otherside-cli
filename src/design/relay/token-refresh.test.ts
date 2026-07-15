import { describe, expect, test } from "bun:test";
import { createTokenRefresher, DESIGN_REMINT_CAP } from "@/design/relay/token-refresh.ts";

function pastIso(): string {
  return new Date(Date.now() - 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTokenRefresher", () => {
  test("default cap is 10", () => {
    expect(DESIGN_REMINT_CAP).toBe(10);
  });

  test("re-mints on expiry and stops at the cap", async () => {
    let mints = 0;
    const updates: string[] = [];
    let exhaustedCalls = 0;
    let resolveExhausted = (): void => {};
    const exhausted = new Promise<void>((resolve) => {
      resolveExhausted = resolve;
    });

    const refresher = createTokenRefresher({
      mint: async () => {
        mints += 1;
        return { url: `https://a/open/t${mints}`, expiresAt: pastIso() };
      },
      isAttached: () => false,
      onUpdate: (url) => {
        updates.push(url);
      },
      onExhausted: () => {
        exhaustedCalls += 1;
        resolveExhausted();
      },
      maxRemints: 3,
    });

    refresher.schedule(pastIso());
    await exhausted;
    refresher.stop();

    expect(mints).toBe(3);
    expect(updates).toEqual(["https://a/open/t1", "https://a/open/t2", "https://a/open/t3"]);
    expect(refresher.remintCount()).toBe(3);
    expect(exhaustedCalls).toBe(1);
  });

  test("stands down once attached", async () => {
    let mints = 0;
    const refresher = createTokenRefresher({
      mint: async () => {
        mints += 1;
        return { url: "u", expiresAt: pastIso() };
      },
      isAttached: () => true,
      onUpdate: () => {},
      onExhausted: () => {
        throw new Error("should not exhaust while attached");
      },
    });
    refresher.schedule(pastIso());
    await sleep(20);
    refresher.stop();
    expect(mints).toBe(0);
  });

  test("stop() cancels a pending re-mint", async () => {
    let mints = 0;
    const refresher = createTokenRefresher({
      mint: async () => {
        mints += 1;
        return { url: "u", expiresAt: pastIso() };
      },
      isAttached: () => false,
      onUpdate: () => {},
      onExhausted: () => {},
    });
    refresher.schedule(new Date(Date.now() + 5).toISOString());
    refresher.stop();
    await sleep(20);
    expect(mints).toBe(0);
  });

  test("failed mints retry and count toward the cap", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    let resolveExhausted = (): void => {};
    const exhausted = new Promise<void>((resolve) => {
      resolveExhausted = resolve;
    });

    const refresher = createTokenRefresher({
      mint: async () => {
        attempts += 1;
        throw new Error("mint down");
      },
      isAttached: () => false,
      onUpdate: () => {
        throw new Error("should never update");
      },
      onExhausted: () => resolveExhausted(),
      onError: (err) => {
        errors.push(err);
      },
      maxRemints: 2,
      retryDelayMs: 1,
    });

    refresher.schedule(pastIso());
    await exhausted;
    refresher.stop();

    expect(attempts).toBe(2);
    expect(errors).toHaveLength(2);
    expect(refresher.remintCount()).toBe(2);
  });
});
