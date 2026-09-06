import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAuth, forceRefreshAuth, saveAuth } from "@/backend/shared/auth.ts";

const PROJECT_ROOT = join(import.meta.dir, "../../../..");
const AUTH_MODULE = join(PROJECT_ROOT, "src/backend/shared/auth.ts");
const homes: string[] = [];
const servers: Bun.Server<unknown>[] = [];
const originalFetch = globalThis.fetch;
const originalRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;

interface ChildResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function createHome(auth: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): string {
  const home = mkdtempSync(join(tmpdir(), "otherside-auth-test-"));
  homes.push(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      access_token: auth.accessToken,
      refresh_token: auth.refreshToken,
      expires_at: auth.expiresAt,
    }),
  );
  return home;
}

async function runLoadFreshAuth(home: string, backendUrl: string): Promise<ChildResult> {
  const script = `
    const { loadFreshAuth } = await import(${JSON.stringify(AUTH_MODULE)});
    const auth = await loadFreshAuth();
    process.stdout.write(JSON.stringify(auth));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      OTHERSIDE_REMOTE_HOME: home,
      OTHERSIDE_CORTEX_URL: backendUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout) as ChildResult;
}

function readStoredAuth(home: string): {
  access_token: string;
  refresh_token: string;
} {
  return JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
    access_token: string;
    refresh_token: string;
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRemoteHome === undefined) delete process.env.OTHERSIDE_REMOTE_HOME;
  else process.env.OTHERSIDE_REMOTE_HOME = originalRemoteHome;
  for (const server of servers.splice(0)) server.stop(true);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("shared remote authentication", () => {
  test("serializes refresh-token rotation across CLI processes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const home = createHome({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: now - 1,
    });
    let refreshRequests = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/auth/refresh");
        refreshRequests += 1;
        await Bun.sleep(100);
        return Response.json({
          status: "success",
          data: {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          },
          request_id: `request-${refreshRequests}`,
        });
      },
    });
    servers.push(server);
    const backendUrl = `http://127.0.0.1:${server.port}`;

    const results = await Promise.all([
      runLoadFreshAuth(home, backendUrl),
      runLoadFreshAuth(home, backendUrl),
    ]);

    expect(refreshRequests).toBe(1);
    expect(results).toEqual([
      { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: expect.any(Number) },
      { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: expect.any(Number) },
    ]);
    expect(readStoredAuth(home)).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  test("adopts a token already refreshed by another process", async () => {
    const home = createHome({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: 0,
    });
    process.env.OTHERSIDE_REMOTE_HOME = home;
    saveAuth({
      accessToken: "access-current",
      refreshToken: "refresh-current",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    let refreshRequests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        refreshRequests += 1;
        throw new Error("unexpected refresh request");
      },
      { preconnect: originalFetch.preconnect },
    );

    const auth = await forceRefreshAuth("access-old");

    expect(refreshRequests).toBe(0);
    expect(auth).toMatchObject({
      accessToken: "access-current",
      refreshToken: "refresh-current",
    });
  });

  test("clearAuth drops credentials without touching linked-device state", () => {
    const home = createHome({
      accessToken: "access-current",
      refreshToken: "refresh-current",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    process.env.OTHERSIDE_REMOTE_HOME = home;
    const peerPath = join(home, "peers", "app-device.json");
    mkdirSync(join(home, "peers"), { recursive: true });
    writeFileSync(peerPath, "linked-device-state");
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          status: "success",
          data: { ok: true },
          request_id: "request-logout",
        }),
      { preconnect: originalFetch.preconnect },
    );

    clearAuth();

    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("");
    expect(readFileSync(peerPath, "utf8")).toBe("linked-device-state");
  });
});
