import { afterEach, describe, expect, test } from "bun:test";
import { designWebUrl, readDesignSessionStatus, refreshDesignSessionLease } from "../wire.ts";

const previousOrigin = process.env.OTHERSIDE_DESIGN_WEB_ORIGIN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOrigin === undefined) delete process.env.OTHERSIDE_DESIGN_WEB_ORIGIN;
  else process.env.OTHERSIDE_DESIGN_WEB_ORIGIN = previousOrigin;
});

describe("design session status", () => {
  test("does not issue a live PATCH for an ended row", async () => {
    const methods: string[] = [];
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          status: "success",
          data: { status: "ended" },
          request_id: "request-1",
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      refreshDesignSessionLease({
        accessToken: "access-token",
        sessionHash: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBe("terminal");
    expect(methods).toEqual(["GET"]);
  });

  test("renews a live row with one PATCH", async () => {
    const methods: string[] = [];
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        return Response.json({
          status: "success",
          data: method === "GET" ? { status: "idle" } : { ok: true },
          request_id: `request-${methods.length}`,
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      refreshDesignSessionLease({
        accessToken: "access-token",
        sessionHash: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBe("active");
    expect(methods).toEqual(["GET", "PATCH"]);
  });

  test("returns null only for a missing session", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json(
          {
            status: "error",
            error_code: "not_found",
            message: "session not found",
            request_id: "request-1",
          },
          { status: 404 },
        ),
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      readDesignSessionStatus({
        accessToken: "access-token",
        sessionHash: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBeNull();
  });
});

describe("designWebUrl", () => {
  test("launches through an open token and keeps cli_pub in the fragment", () => {
    const url = designWebUrl("open_token_123", "cli_pub_456");
    expect(url).toBe("https://design.othersidecli.com/open/open_token_123#k=cli_pub_456");
  });

  test("trims the configured origin", () => {
    process.env.OTHERSIDE_DESIGN_WEB_ORIGIN = "http://localhost:5173///";
    const url = designWebUrl("token", "pub");
    expect(url).toBe("http://localhost:5173/open/token#k=pub");
  });

  test("encodes the open token path segment", () => {
    const url = designWebUrl("token/with/slash", "pub");
    expect(url).toBe("https://design.othersidecli.com/open/token%2Fwith%2Fslash#k=pub");
  });
});
