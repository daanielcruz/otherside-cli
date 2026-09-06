import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAuth } from "@/backend/shared/auth.ts";
import {
  setActiveSyncSessionId,
  setSessionRegistered,
  setSessionTitle,
} from "../session-status.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;

function fakeAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url");
  return `${header}.${claims}.sig`;
}

function setFetchMock(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

describe("remote session title synchronization", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "remote-title-test-"));
    process.env.OTHERSIDE_REMOTE_HOME = home;
    saveAuth({
      accessToken: fakeAccessToken(),
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    setActiveSyncSessionId(SESSION_ID);
    setSessionRegistered(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setActiveSyncSessionId(null);
    setSessionRegistered(false);
    delete process.env.OTHERSIDE_REMOTE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("reports success only after the backend accepts the title", async () => {
    setFetchMock(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.title).toMatchObject({ v: 1 });
      return new Response(
        JSON.stringify({ status: "success", data: { ok: true }, request_id: "request-1" }),
        { status: 200 },
      );
    });

    await expect(setSessionTitle("Generated title")).resolves.toBe(true);
  });

  test("keeps a rejected title eligible for retry", async () => {
    setFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            status: "error",
            error_code: "internal",
            message: "retry later",
            request_id: "request-2",
          }),
          { status: 503 },
        ),
    );

    await expect(setSessionTitle("Generated title")).resolves.toBe(false);
  });

  test("does not send a title before registration", async () => {
    let called = false;
    setFetchMock(async () => {
      called = true;
      throw new Error("unexpected fetch");
    });
    setSessionRegistered(false);

    await expect(setSessionTitle("Generated title")).resolves.toBe(false);
    expect(called).toBe(false);
  });
});
