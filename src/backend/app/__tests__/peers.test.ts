import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePeer, savePeer, signOutRemote } from "@/backend/app/peers.ts";
import { saveAuth } from "@/backend/shared/auth.ts";
import { ensureDevice } from "@/backend/shared/device.ts";

const originalFetch = globalThis.fetch;
const originalRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;
let home: string | null = null;

function accessToken(userId: string, scope = "full"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: userId, scp: scope })).toString("base64url");
  return `${header}.${claims}.signature`;
}

function signIn(userId: string, scope = "full"): void {
  saveAuth({
    accessToken: accessToken(userId, scope),
    refreshToken: `refresh-${userId}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRemoteHome === undefined) delete process.env.OTHERSIDE_REMOTE_HOME;
  else process.env.OTHERSIDE_REMOTE_HOME = originalRemoteHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("remote sign-out", () => {
  test("releases pairings with the live token before dropping credentials", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-signout-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    signIn("account-a");
    const device = ensureDevice();
    savePeer({
      deviceId: "app-device",
      userId: "account-a",
      label: "Test app",
      kind: "app",
      pub: new Uint8Array(32),
      verifiedAt: new Date().toISOString(),
    });
    const calls: { path: string; authorized: boolean }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        calls.push({
          path: new URL(url).pathname,
          authorized: (headers.get("Authorization") ?? "").startsWith("Bearer "),
        });
        return Response.json({
          status: "success",
          data: { ok: true },
          request_id: `request-${calls.length}`,
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    await signOutRemote();

    const unpairCall = calls.find((call) => call.path === "/v1/pairings/unpair");
    expect(unpairCall).toEqual({ path: "/v1/pairings/unpair", authorized: true });
    expect(existsSync(join(home, "peers", "app-device.json"))).toBe(false);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("");
    // Signing back into the same account resolves the durable device id (it
    // names this machine's backend environment row); only the keypair rotated.
    signIn("account-a");
    const after = ensureDevice();
    expect(after.id).toBe(device.id);
    expect(after.pub).not.toEqual(device.pub);
  });

  test("unpair self-revokes the last device-scoped credential", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-device-unpair-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    signIn("account-device", "device");
    ensureDevice();
    savePeer({
      deviceId: "app-device",
      userId: "account-device",
      label: "Test companion",
      kind: "app",
      pub: new Uint8Array(32),
      verifiedAt: new Date().toISOString(),
    });
    const calls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push(new URL(url).pathname);
        return Response.json({
          status: "success",
          data: { revoked: true },
          request_id: `request-${calls.length}`,
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    await removePeer("app-device");

    expect(calls).toEqual(["/v1/pairings/unpair", "/v1/auth/device/revoke"]);
    expect(existsSync(join(home, "peers", "app-device.json"))).toBe(false);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("");
  });

  test("self-revokes a device credential before clearing it locally", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-device-revoke-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    signIn("account-device", "device");
    const calls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push(new URL(url).pathname);
        return Response.json({
          status: "success",
          data: { revoked: true },
          request_id: "request-device-revoke",
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    await signOutRemote();

    expect(calls).toEqual(["/v1/auth/device/revoke"]);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("");
  });
});
