import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTokens, resolveProjectId } from "@/engine/providers/antigravity/auth.ts";
import * as transport from "@/engine/transport/http1-socket.ts";
import { AccountVerificationError } from "@/kernel/std/types/error-meta.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

const originalFetch = globalThis.fetch;
let configDir: string;

describe("antigravity OAuth refresh", () => {
  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "antigravity-auth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("antigravity", {
      accessToken: "expired_access",
      refreshToken: "google_refresh",
      expiresAt: Date.now() - 1,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("single-flights concurrent refreshes", async () => {
    let refreshCalls = 0;
    globalThis.fetch = mock(async () => {
      refreshCalls++;
      return new Response(
        JSON.stringify({
          access_token: "fresh_access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([currentTokens(), currentTokens()]);

    expect(refreshCalls).toBe(1);
    expect(first.accessToken).toBe("fresh_access");
    expect(second.accessToken).toBe("fresh_access");
  });
});

describe("antigravity account verification", () => {
  const VERIFY_AT = "https://accounts.google.com/signin/continue?sarp=1&plt=probe";
  const tokens = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
  };

  let sendSpy: ReturnType<typeof spyOn> | undefined;

  async function* bodyBytes(text: string): AsyncIterable<Uint8Array> {
    yield Buffer.from(text, "utf8");
  }

  function answering(body: unknown, status = 200): void {
    sendSpy?.mockRestore();
    sendSpy = spyOn(transport, "sendSizedRequest").mockImplementation(async () => ({
      status,
      headers: new Map(),
      body: bodyBytes(JSON.stringify(body)),
    }));
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "antigravity-verify-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    sendSpy?.mockRestore();
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("a sign-in check the backend refuses until verification hands over its page", async () => {
    answering(
      {
        error: {
          code: 403,
          message: "Verify your account to continue.",
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "VALIDATION_REQUIRED",
              metadata: { validation_url: VERIFY_AT },
            },
          ],
        },
      },
      403,
    );
    const seen: [string, string][] = [];
    await expect(
      resolveProjectId(tokens, async (url, message) => {
        seen.push([url, message]);
        return "cancel";
      }),
    ).rejects.toThrow("account validation cancelled");
    expect(seen).toEqual([[VERIFY_AT, "Verify your account to continue."]]);

    await expect(resolveProjectId(tokens)).rejects.toThrow(`verify at ${VERIFY_AT}`);
  });

  test("a free tier the account may not use asks for verification when none is offered", async () => {
    answering({
      allowedTiers: [{ id: "standard-tier", userDefinedCloudaicompanionProject: true }],
      ineligibleTiers: [
        {
          tierId: "free-tier",
          reasonMessage: "Your current account is not eligible for Antigravity.",
          validationUrl: VERIFY_AT,
        },
      ],
    });
    const seen: string[] = [];
    await expect(
      resolveProjectId(tokens, async (url) => {
        seen.push(url);
        return "cancel";
      }),
    ).rejects.toThrow("account validation cancelled");
    expect(seen).toEqual([VERIFY_AT]);
  });

  test("an ineligible free tier with no page to verify at reports the reason", async () => {
    answering({
      ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "Not available in your region." }],
    });
    const handler = mock(async () => "verify" as const);
    await expect(resolveProjectId(tokens, handler)).rejects.toBeInstanceOf(
      AccountVerificationError,
    );
    await expect(resolveProjectId(tokens, handler)).rejects.toThrow(
      "Not available in your region.",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
