import { afterEach, describe, expect, test } from "bun:test";
import {
  getBySession,
  getLinkExpiresAt,
  getUnreachableReason,
  isLinkExpired,
  markLinkExpired,
  markReachable,
  markUnreachable,
  register,
  setSpawnLink,
  subscribe,
  unregister,
} from "@/design/spawn-registry.ts";
import type { DesignSpawn } from "@/design/types.ts";

function fakeSpawn(id: string, sessionId: string, url: string): DesignSpawn {
  return {
    id,
    sessionId,
    sessionHash: `hash-${id}`,
    url,
    attached: false,
    stop: async () => {},
  } as unknown as DesignSpawn;
}

const registered: string[] = [];

function registerSpawn(spawn: DesignSpawn): void {
  register(spawn);
  registered.push(spawn.id);
}

afterEach(() => {
  for (const id of registered.splice(0)) unregister(id);
});

describe("setSpawnLink", () => {
  test("stores expiry before the spawn is registered and survives register()", () => {
    setSpawnLink("s1", "https://a/open/t1", "2099-01-01T00:00:00Z");
    expect(getLinkExpiresAt("s1")).toBe("2099-01-01T00:00:00Z");

    registerSpawn(fakeSpawn("s1", "sess-1", "https://a/open/t1"));
    expect(getLinkExpiresAt("s1")).toBe("2099-01-01T00:00:00Z");
    unregister("s1");
    registered.length = 0;
    expect(getLinkExpiresAt("s1")).toBeNull();
  });

  test("swaps the live spawn url and restarts the countdown", () => {
    registerSpawn(fakeSpawn("s2", "sess-2", "https://a/open/old"));
    setSpawnLink("s2", "https://a/open/new", "2099-06-01T00:00:00Z");
    expect(getBySession("sess-2")?.url).toBe("https://a/open/new");
    expect(getLinkExpiresAt("s2")).toBe("2099-06-01T00:00:00Z");
  });

  test("clears a previous expired flag on re-mint", () => {
    registerSpawn(fakeSpawn("s3", "sess-3", "u"));
    markLinkExpired("s3");
    expect(isLinkExpired("s3")).toBe(true);
    expect(getLinkExpiresAt("s3")).toBeNull();
    setSpawnLink("s3", "u2", "2099-01-01T00:00:00Z");
    expect(isLinkExpired("s3")).toBe(false);
    expect(getLinkExpiresAt("s3")).toBe("2099-01-01T00:00:00Z");
  });

  test("notifies subscribers on link updates", () => {
    registerSpawn(fakeSpawn("s4", "sess-4", "u"));
    let calls = 0;
    const off = subscribe(() => {
      calls += 1;
    });
    setSpawnLink("s4", "u2", "2099-01-01T00:00:00Z");
    markLinkExpired("s4");
    markLinkExpired("s4"); // already expired — no extra notify
    off();
    expect(calls).toBe(2);
  });
});

describe("unreachable state", () => {
  test("flags and clears with subscriber notifications", () => {
    registerSpawn(fakeSpawn("s5", "sess-5", "u"));
    let calls = 0;
    const off = subscribe(() => {
      calls += 1;
    });

    expect(getUnreachableReason("s5")).toBeNull();
    markReachable("s5"); // not flagged — no notify
    expect(calls).toBe(0);

    markUnreachable("s5", "HTTP 500");
    expect(getUnreachableReason("s5")).toBe("HTTP 500");
    markUnreachable("s5", "HTTP 500"); // same reason — no extra notify
    expect(calls).toBe(1);

    markUnreachable("s5", "HTTP 401"); // reason changed — notify
    expect(getUnreachableReason("s5")).toBe("HTTP 401");
    expect(calls).toBe(2);

    markReachable("s5");
    expect(getUnreachableReason("s5")).toBeNull();
    expect(calls).toBe(3);
    off();
  });

  test("unregister clears the unreachable flag", () => {
    registerSpawn(fakeSpawn("s6", "sess-6", "u"));
    markUnreachable("s6", "HTTP 500");
    unregister("s6");
    registered.length = 0;
    expect(getUnreachableReason("s6")).toBeNull();
  });
});
