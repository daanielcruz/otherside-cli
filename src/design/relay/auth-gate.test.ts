import { describe, expect, test } from "bun:test";
import type { AuthUnavailableReason, RemoteAuth } from "@/backend/shared/auth.ts";
import {
  createRelayAuthGate,
  DESIGN_RELAY_SIGNED_OUT,
  type RelayAuthSource,
} from "@/design/relay/auth-gate.ts";

interface Harness {
  source: RelayAuthSource;
  stored: RemoteAuth | null;
  fresh: RemoteAuth | null;
  reason: AuthUnavailableReason;
  freshCalls: number;
  signedOut: string[];
  restored: number;
}

function auth(accessToken: string): RemoteAuth {
  return { accessToken, refreshToken: `refresh-${accessToken}`, expiresAt: 4_102_444_800 };
}

function harness(): Harness {
  const state: Harness = {
    stored: null,
    fresh: null,
    reason: "signed_out",
    freshCalls: 0,
    signedOut: [],
    restored: 0,
    source: {
      loadAuth: () => state.stored,
      loadFreshAuth: async () => {
        state.freshCalls += 1;
        return state.fresh;
      },
      authUnavailableReason: () => state.reason,
    },
  };
  return state;
}

function gateFor(state: Harness) {
  return createRelayAuthGate(
    {
      onSignedOut: (reason) => state.signedOut.push(reason),
      onRestored: () => {
        state.restored += 1;
      },
    },
    state.source,
  );
}

describe("relay auth gate", () => {
  test("passes while fresh auth is available", async () => {
    const state = harness();
    state.stored = auth("live");
    state.fresh = state.stored;
    const gate = gateFor(state);

    await expect(gate.ready()).resolves.toBe(true);
    expect(state.signedOut).toEqual([]);
    expect(state.restored).toBe(0);
  });

  test("skips a pending refresh without declaring the session signed out", async () => {
    const state = harness();
    state.stored = auth("expired");
    state.fresh = null;
    state.reason = "refresh_pending";
    const gate = gateFor(state);

    await expect(gate.ready()).resolves.toBe(false);
    await expect(gate.ready()).resolves.toBe(false);
    expect(state.signedOut).toEqual([]);
    expect(state.freshCalls).toBe(2);
  });

  test("reports a rejected sign-in once and stops asking the backend until a new login lands", async () => {
    const state = harness();
    state.stored = auth("rejected");
    state.fresh = null;
    state.reason = "rejected";
    const gate = gateFor(state);

    await expect(gate.ready()).resolves.toBe(false);
    await expect(gate.ready()).resolves.toBe(false);
    await expect(gate.ready()).resolves.toBe(false);
    expect(state.signedOut).toEqual([DESIGN_RELAY_SIGNED_OUT]);
    expect(state.freshCalls).toBe(1);

    state.stored = auth("renewed");
    state.fresh = state.stored;
    await expect(gate.ready()).resolves.toBe(true);
    expect(state.restored).toBe(1);
    expect(state.freshCalls).toBe(2);

    await expect(gate.ready()).resolves.toBe(true);
    expect(state.restored).toBe(1);
  });

  test("treats cleared credentials as signed out and recovers after sign-in", async () => {
    const state = harness();
    state.stored = null;
    state.fresh = null;
    state.reason = "signed_out";
    const gate = gateFor(state);

    await expect(gate.ready()).resolves.toBe(false);
    await expect(gate.ready()).resolves.toBe(false);
    expect(state.signedOut).toEqual([DESIGN_RELAY_SIGNED_OUT]);
    expect(state.freshCalls).toBe(1);

    state.stored = auth("signed-in");
    state.fresh = state.stored;
    await expect(gate.ready()).resolves.toBe(true);
    expect(state.restored).toBe(1);
  });

  test("keeps waiting when the stored token is still the rejected one", async () => {
    const state = harness();
    state.stored = auth("rejected");
    state.fresh = null;
    state.reason = "rejected";
    const gate = gateFor(state);
    await gate.ready();

    state.fresh = auth("rejected");
    await expect(gate.ready()).resolves.toBe(false);
    expect(state.freshCalls).toBe(1);
    expect(state.restored).toBe(0);
  });
});
