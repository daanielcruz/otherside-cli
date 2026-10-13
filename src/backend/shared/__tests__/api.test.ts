import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionEvents, RemoteApiError, registerEnvironment } from "@/backend/shared/api.ts";
import { saveAuth } from "@/backend/shared/auth.ts";

const originalFetch = globalThis.fetch;
const originalRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;
let home: string | null = null;

function accessToken(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: userId })).toString("base64url");
  return `${header}.${claims}.signature`;
}

function signIn(userId: string): void {
  saveAuth({
    accessToken: accessToken(userId),
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

describe("session event pages", () => {
  test("sends an atomic forward cursor", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-event-page-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    signIn("account-a");
    let requestUrl = "";
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requestUrl = String(input);
        return Response.json({ status: "success", data: [], request_id: "request-1" });
      },
      { preconnect: originalFetch.preconnect },
    );

    await listSessionEvents("11111111-1111-4111-8111-111111111111", {
      limit: 100,
      after: {
        ts: "2026-07-21T00:00:00.000Z",
        id: "22222222-2222-4222-8222-222222222222",
      },
    });

    const url = new URL(requestUrl);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("after_ts")).toBe("2026-07-21T00:00:00.000Z");
    expect(url.searchParams.get("after_id")).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("refreshes once and replays the page when the server rejects the token", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-event-page-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    signIn("account-a");
    const bearerTokens: string[] = [];
    let refreshes = 0;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/refresh")) {
          refreshes += 1;
          return Response.json({
            status: "success",
            data: {
              access_token: accessToken("account-a-renewed"),
              refresh_token: "refresh-renewed",
              expires_in: 3600,
            },
            request_id: "request-refresh",
          });
        }
        const headers = new Headers(init?.headers);
        bearerTokens.push(headers.get("Authorization") ?? "");
        if (bearerTokens.length === 1) {
          return Response.json(
            {
              status: "error",
              error_code: "unauthorized",
              message: "invalid token",
              request_id: "request-401",
            },
            { status: 401 },
          );
        }
        return Response.json({ status: "success", data: [], request_id: "request-2" });
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(listSessionEvents("11111111-1111-4111-8111-111111111111")).resolves.toEqual([]);

    expect(refreshes).toBe(1);
    expect(bearerTokens).toEqual([
      `Bearer ${accessToken("account-a")}`,
      `Bearer ${accessToken("account-a-renewed")}`,
    ]);
  });

  test("names missing credentials instead of a generic rejection", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-event-page-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json({ status: "success", data: [], request_id: "request-1" });
      },
      { preconnect: originalFetch.preconnect },
    );

    const failure = await listSessionEvents("11111111-1111-4111-8111-111111111111").catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(RemoteApiError);
    expect((failure as RemoteApiError).code).toBe("unauthorized");
    expect((failure as RemoteApiError).message).toBe("CLI is not paired — run /remote pair");
    expect(requests).toBe(0);
  });
});

describe("environment registration", () => {
  test("deduplicates only the same account and device identity", async () => {
    home = mkdtempSync(join(tmpdir(), "otherside-environment-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    signIn("account-a");
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json({
          status: "success",
          data: {
            environment_id: `environment-${requests}`,
            created: true,
          },
          request_id: `request-${requests}`,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const input = {
      id: "device-a",
      device_label: "Test CLI",
      fingerprint_hash: "fingerprint",
      kind: "cli" as const,
    };

    const duplicate = await Promise.all([registerEnvironment(input), registerEnvironment(input)]);
    const differentDevice = await registerEnvironment({ ...input, id: "device-b" });
    signIn("account-b");
    const differentAccount = await registerEnvironment(input);

    expect(requests).toBe(3);
    expect(duplicate[0]).toEqual(duplicate[1]);
    expect(differentDevice.environment_id).toBe("environment-2");
    expect(differentAccount.environment_id).toBe("environment-3");
  });
});
